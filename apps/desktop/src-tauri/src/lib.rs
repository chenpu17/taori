//! Taori desktop shell.
//!
//! Responsibilities:
//!   1. Spawn the Node sidecar binary (or, in dev, run `node ./apps/sidecar/dist/index.js`
//!      via the TAORI_DEV_SIDECAR_CMD env var).
//!   2. Read the sidecar's first stdout line `READY <port> <bearer>`.
//!   3. Stand up an axum-backed control channel on 127.0.0.1:<random> with a
//!      Bearer token, so the sidecar can write/read the OS Keychain and read
//!      local files for upload.
//!   4. Expose two Tauri commands to the Renderer:
//!        - `sidecar_endpoint() -> { url, bearer }`
//!        - `control_health()    -> bool`     (debug only)
//!
//! All logs go to stderr via tracing; stdout is kept clean.

mod automation;
mod control;
mod sidecar;

use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tokio::sync::OnceCell;

#[derive(Clone, Serialize)]
pub struct SidecarEndpoint {
    pub url: String,
    pub bearer: String,
}

pub struct AppState {
    pub sidecar: OnceCell<SidecarEndpoint>,
    pub control_bearer: String,
    pub control_url: String,
}

#[tauri::command]
async fn sidecar_endpoint(state: State<'_, Arc<AppState>>) -> Result<SidecarEndpoint, String> {
    state
        .sidecar
        .get()
        .cloned()
        .ok_or_else(|| "sidecar not ready".to_string())
}

#[tauri::command]
async fn control_health() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let runtime = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    let _enter = runtime.enter();

    // Reserve control channel addr+token before launching anything else.
    let control_bearer = control::random_token();
    let (control_url, control_handle) = runtime
        .block_on(control::start_control_channel(control_bearer.clone()))
        .expect("failed to start control channel");
    tracing::info!("control channel up at {}", control_url);

    let app_state = Arc::new(AppState {
        sidecar: OnceCell::new(),
        control_bearer: control_bearer.clone(),
        control_url: control_url.clone(),
    });

    tauri::Builder::default()
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![sidecar_endpoint, control_health])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let automation_handle = app.handle().clone();
            let state = app_state.clone();
            let control_url_for_spawn = control_url.clone();
            let control_bearer_for_spawn = control_bearer.clone();
            let automation_bearer = std::env::var("TAORI_DESKTOP_AUTOMATION_BEARER")
                .unwrap_or_else(|_| control_bearer.clone());
            tauri::async_runtime::spawn(async move {
                match automation::maybe_start(automation_handle, automation_bearer).await {
                    Ok(Some((url, handle))) => {
                        tracing::info!("automation channel up at {}", url);
                        std::mem::forget(handle);
                    }
                    Ok(None) => {}
                    Err(e) => tracing::error!("automation channel failed: {:#}", e),
                }
            });
            // Spawn sidecar in background; block readiness wait off the main thread.
            tauri::async_runtime::spawn(async move {
                match sidecar::spawn_sidecar(
                    &app_handle,
                    &control_url_for_spawn,
                    &control_bearer_for_spawn,
                )
                .await
                {
                    Ok(ep) => {
                        tracing::info!(
                            "sidecar ready at {} (bearer prefix={}…)",
                            ep.url,
                            &ep.bearer[..ep.bearer.len().min(6)]
                        );
                        let _ = state.sidecar.set(ep);
                    }
                    Err(e) => {
                        tracing::error!("sidecar spawn failed: {:#}", e);
                    }
                }
            });
            // Hold the control-channel task handle for the lifetime of the app.
            std::mem::forget(control_handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Taori");
}
