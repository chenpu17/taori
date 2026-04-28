//! Control channel: a localhost-only HTTP server the sidecar uses to call into
//! Rust for OS-Keychain access. Bearer-token authenticated.
//!
//! Endpoints (all under no prefix; bind to 127.0.0.1:<random>):
//!   GET  /health
//!   POST /v1/keychain/write   { service, account, secret }
//!   POST /v1/keychain/read    { service, account } -> { secret }
//!   POST /v1/keychain/delete  { service, account }
//!
//! NOTE: `/v1/files/read` is intentionally NOT exposed in M0. Reading files
//! crosses the security boundary defined in 05-security.md ("Sidecar must not
//! read arbitrary local files"), and a proper allowlist mechanism (driven by
//! user file-drop events from the Renderer/Tauri) will land in M1.

use std::net::SocketAddr;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Clone)]
struct ControlState {
    bearer: String,
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub async fn start_control_channel(
    bearer: String,
) -> anyhow::Result<(String, JoinHandle<()>)> {
    let state = ControlState {
        bearer: bearer.clone(),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/keychain/write", post(keychain_write))
        .route("/v1/keychain/read", post(keychain_read))
        .route("/v1/keychain/delete", post(keychain_delete))
        .with_state(state);

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let addr = listener.local_addr()?;
    let url = format!("http://{}", addr);

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app.into_make_service()).await {
            tracing::error!("control channel server exited: {}", e);
        }
    });

    Ok((url, handle))
}

fn check_auth(state: &ControlState, headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let h = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", state.bearer);
    // Constant-time comparison to defeat timing-based token recovery.
    // `ConstantTimeEq` from `subtle` requires equal-length inputs to be safe;
    // we explicitly check length first (length itself is not secret) and bail
    // early on mismatch, which leaks only the public bearer length, not bytes.
    if h.len() != expected.len() {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    if h.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
}

async fn health() -> impl IntoResponse {
    Json(HealthBody { ok: true })
}

#[derive(Deserialize)]
struct KeychainWriteIn {
    service: String,
    account: String,
    secret: String,
}

async fn keychain_write(
    State(state): State<ControlState>,
    headers: HeaderMap,
    Json(body): Json<KeychainWriteIn>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&state, &headers) {
        return err_resp(e.0, e.1);
    }
    let entry = match keyring::Entry::new(&body.service, &body.account) {
        Ok(e) => e,
        Err(e) => return err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring: {e}")),
    };
    match entry.set_password(&body.secret) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring write: {e}")),
    }
}

#[derive(Deserialize)]
struct KeychainReadIn {
    service: String,
    account: String,
}

#[derive(Serialize)]
struct KeychainReadOut {
    secret: String,
}

async fn keychain_read(
    State(state): State<ControlState>,
    headers: HeaderMap,
    Json(body): Json<KeychainReadIn>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&state, &headers) {
        return err_resp(e.0, e.1);
    }
    let entry = match keyring::Entry::new(&body.service, &body.account) {
        Ok(e) => e,
        Err(e) => return err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring: {e}")),
    };
    match entry.get_password() {
        Ok(secret) => (StatusCode::OK, Json(KeychainReadOut { secret })).into_response(),
        Err(keyring::Error::NoEntry) => err_resp(StatusCode::NOT_FOUND, "no entry"),
        Err(e) => err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring read: {e}")),
    }
}

async fn keychain_delete(
    State(state): State<ControlState>,
    headers: HeaderMap,
    Json(body): Json<KeychainReadIn>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&state, &headers) {
        return err_resp(e.0, e.1);
    }
    let entry = match keyring::Entry::new(&body.service, &body.account) {
        Ok(e) => e,
        Err(e) => return err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring: {e}")),
    };
    match entry.delete_credential() {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(keyring::Error::NoEntry) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true, "noop": true})),
        )
            .into_response(),
        Err(e) => err_resp(StatusCode::INTERNAL_SERVER_ERROR, &format!("keyring delete: {e}")),
    }
}

fn err_resp(code: StatusCode, msg: &str) -> axum::response::Response {
    (
        code,
        Json(serde_json::json!({
            "error": { "code": "control_error", "message": msg }
        })),
    )
        .into_response()
}
