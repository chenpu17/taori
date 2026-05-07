//! Debug-only WebView automation channel.
//!
//! macOS has no Tauri WebDriver backend, so this module gives our local smoke
//! script a narrow localhost control plane for driving the real Tauri WebView.
//! It is only started in debug builds and only when TAORI_DESKTOP_AUTOMATION=1.

#[cfg(debug_assertions)]
mod debug {
    use std::{
        collections::HashMap,
        net::SocketAddr,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

use axum::{
        body::Bytes,
        extract::{Path, State},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use serde::{Deserialize, Serialize};
    use subtle::ConstantTimeEq;
    use tauri::{AppHandle, Manager};
    use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

    #[derive(Clone)]
    struct AutomationState {
        bearer: String,
        app: AppHandle,
        url: String,
        pending: Arc<Mutex<HashMap<String, oneshot::Sender<AutomationResult>>>>,
    }

    #[derive(Deserialize)]
    struct EvalIn {
        script: String,
        timeout_ms: Option<u64>,
    }

    #[derive(Deserialize)]
    struct ResultIn {
        id: String,
        bearer: Option<String>,
        ok: bool,
        value: Option<serde_json::Value>,
        error: Option<String>,
    }

    #[derive(Clone, Serialize, Deserialize)]
    struct AutomationResult {
        ok: bool,
        value: Option<serde_json::Value>,
        error: Option<String>,
    }

    #[derive(Serialize)]
    struct EvalOut {
        ok: bool,
        value: Option<serde_json::Value>,
    }

    #[derive(Serialize)]
    struct HealthOut {
        ok: bool,
    }

    pub async fn maybe_start(
        app: AppHandle,
        bearer: String,
    ) -> anyhow::Result<Option<(String, JoinHandle<()>)>> {
        if std::env::var("TAORI_DESKTOP_AUTOMATION").ok().as_deref() != Some("1") {
            return Ok(None);
        }

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let addr = listener.local_addr()?;
        let url = format!("http://{}", addr);
        let state = AutomationState {
            bearer,
            app,
            url: url.clone(),
            pending: Arc::new(Mutex::new(HashMap::new())),
        };
        let router = Router::new()
            .route("/health", get(health))
            .route("/v1/eval", post(eval))
            .route("/v1/result/:id", post(result))
            .with_state(state);

        let handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router.into_make_service()).await {
                tracing::error!("automation channel server exited: {}", e);
            }
        });
        Ok(Some((url, handle)))
    }

    async fn health() -> impl IntoResponse {
        Json(HealthOut { ok: true })
    }

    async fn eval(
        State(state): State<AutomationState>,
        headers: HeaderMap,
        Json(body): Json<EvalIn>,
    ) -> impl IntoResponse {
        if let Err(e) = check_auth(&state, &headers) {
            return err_resp(e.0, e.1);
        }

        let id = make_request_id();
        tracing::info!("automation eval scheduled id={}", id);
        let (tx, rx) = oneshot::channel();
        state.pending.lock().expect("pending lock poisoned").insert(id.clone(), tx);

        let callback_url = format!("{}/v1/result/{}", state.url, id);
        let bearer = state.bearer.clone();
        let script = build_eval_script(&id, &callback_url, &bearer, &body.script);
        let (eval_tx, eval_rx) = oneshot::channel();
        let app = state.app.clone();
        if let Err(e) = state.app.run_on_main_thread(move || {
            let result = match app.get_webview_window("main") {
                Some(webview) => webview.eval(script).map_err(|e| e.to_string()),
                None => Err("main webview is not ready".to_string()),
            };
            let _ = eval_tx.send(result);
        }) {
            state.pending.lock().expect("pending lock poisoned").remove(&id);
            return err_resp(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("schedule webview eval failed: {e}"),
            );
        }
        match tokio::time::timeout(std::time::Duration::from_secs(5), eval_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => {
                state.pending.lock().expect("pending lock poisoned").remove(&id);
                return err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("webview eval failed: {e}"));
            }
            Ok(Err(_)) => {
                state.pending.lock().expect("pending lock poisoned").remove(&id);
                return err_resp(StatusCode::GONE, "webview eval schedule channel closed");
            }
            Err(_) => {
                state.pending.lock().expect("pending lock poisoned").remove(&id);
                return err_resp(StatusCode::REQUEST_TIMEOUT, "webview eval scheduling timed out");
            }
        }

        let timeout = std::time::Duration::from_millis(body.timeout_ms.unwrap_or(30_000));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) if result.ok => {
                tracing::info!("automation eval completed id={}", id);
                (
                    StatusCode::OK,
                    Json(EvalOut {
                        ok: true,
                        value: result.value,
                    }),
                )
                    .into_response()
            }
            Ok(Ok(result)) => err_resp(
                StatusCode::BAD_REQUEST,
                result.error.as_deref().unwrap_or("webview script failed"),
            ),
            Ok(Err(_)) => err_resp(StatusCode::GONE, "webview result channel closed"),
            Err(_) => {
                tracing::warn!("automation eval timed out id={}", id);
                state.pending.lock().expect("pending lock poisoned").remove(&id);
                err_resp(StatusCode::REQUEST_TIMEOUT, "webview eval timed out")
            }
        }
    }

    async fn result(
        State(state): State<AutomationState>,
        headers: HeaderMap,
        Path(id): Path<String>,
        body_bytes: Bytes,
    ) -> impl IntoResponse {
        let body = match serde_json::from_slice::<ResultIn>(&body_bytes) {
            Ok(body) => body,
            Err(e) => return err_resp(StatusCode::BAD_REQUEST, &format!("invalid result body: {e}")),
        };
        if let Err(e) = check_auth_or_body_bearer(&state, &headers, body.bearer.as_deref()) {
            return err_resp(e.0, e.1);
        }
        if body.id != id {
            return err_resp(StatusCode::BAD_REQUEST, "result id mismatch");
        }
        let tx = state.pending.lock().expect("pending lock poisoned").remove(&id);
        if let Some(tx) = tx {
            tracing::info!("automation result received id={} ok={}", id, body.ok);
            let _ = tx.send(AutomationResult {
                ok: body.ok,
                value: body.value,
                error: body.error,
            });
        }
        (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
    }

    fn check_auth(state: &AutomationState, headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
        check_auth_or_body_bearer(state, headers, None)
    }

    fn check_auth_or_body_bearer(
        state: &AutomationState,
        headers: &HeaderMap,
        body_bearer: Option<&str>,
    ) -> Result<(), (StatusCode, &'static str)> {
        if let Some(value) = body_bearer {
            if value.len() == state.bearer.len() && value.as_bytes().ct_eq(state.bearer.as_bytes()).into() {
                return Ok(());
            }
        }
        let h = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let expected = format!("Bearer {}", state.bearer);
        if h.len() != expected.len() {
            return Err((StatusCode::UNAUTHORIZED, "unauthorized"));
        }
        if h.as_bytes().ct_eq(expected.as_bytes()).into() {
            Ok(())
        } else {
            Err((StatusCode::UNAUTHORIZED, "unauthorized"))
        }
    }

    fn err_resp(code: StatusCode, msg: &str) -> axum::response::Response {
        (
            code,
            Json(serde_json::json!({
                "error": { "code": "automation_error", "message": msg }
            })),
        )
            .into_response()
    }

    fn make_request_id() -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("auto_{now}_{}", rand::random::<u32>())
    }

    fn build_eval_script(id: &str, callback_url: &str, bearer: &str, user_script: &str) -> String {
        let id_json = serde_json::to_string(id).expect("json id");
        let callback_json = serde_json::to_string(callback_url).expect("json callback");
        let bearer_json = serde_json::to_string(bearer).expect("json bearer");
        let user_script_json = serde_json::to_string(user_script).expect("json script");
        format!(
            r#"(async () => {{
  const id = {id_json};
  const callbackUrl = {callback_json};
  const bearer = {bearer_json};
  const source = {user_script_json};
  const finish = async (payload) => {{
    await fetch(callbackUrl, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'text/plain;charset=UTF-8' }},
      body: JSON.stringify({{ id, bearer, ...payload }}),
    }});
  }};
  try {{
    const fn = new Function(`return (async () => {{\n${{source}}\n}})();`);
    const value = await fn();
    await finish({{ ok: true, value: value === undefined ? null : value }});
  }} catch (error) {{
    const message = error && error.message ? String(error.message) : String(error);
    const stack = error && error.stack ? String(error.stack) : '';
    await finish({{ ok: false, error: stack ? `${{message}}\n${{stack}}` : message }});
  }}
}})();"#
        )
    }
}

#[cfg(debug_assertions)]
pub use debug::maybe_start;

#[cfg(not(debug_assertions))]
pub async fn maybe_start(
    _app: tauri::AppHandle,
    _bearer: String,
) -> anyhow::Result<Option<(String, tokio::task::JoinHandle<()>)>> {
    Ok(None)
}
