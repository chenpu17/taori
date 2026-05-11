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

use anyhow::anyhow;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use serde::Serialize;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, Window, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, GlobalShortcutExt, ShortcutState};
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

#[derive(Clone, Copy)]
pub(crate) enum DesktopShellAction {
    ToggleWindow,
    ShowWindow,
    NewChat,
    OpenSettings,
    OpenHelp,
    ImportClipboard,
    Quit,
}

#[derive(Clone, Serialize)]
struct DesktopShellActionPayload {
    action: &'static str,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    clipboard_items: Option<Vec<DesktopClipboardItemPayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct DesktopClipboardItemPayload {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

const DESKTOP_ACTION_EVENT: &str = "taori:desktop-action";
const MAIN_WINDOW_LABEL: &str = "main";
const DESKTOP_SHORTCUT_TOGGLE: &str = "CmdOrCtrl+Shift+Space";
const DESKTOP_SHORTCUT_NEW_CHAT: &str = "CmdOrCtrl+Shift+N";
const DESKTOP_SHORTCUT_IMPORT_CLIPBOARD: &str = "CmdOrCtrl+Shift+V";

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

#[tauri::command]
async fn import_clipboard(app: AppHandle) -> Result<(), String> {
    trigger_clipboard_import(&app, "renderer_button");
    Ok(())
}

pub(crate) fn handle_desktop_shell_action<R: Runtime>(
    app: &AppHandle<R>,
    action: DesktopShellAction,
    source: &'static str,
) -> anyhow::Result<()> {
    match action {
        DesktopShellAction::ToggleWindow => toggle_main_window(app),
        DesktopShellAction::ShowWindow => show_main_window(app),
        DesktopShellAction::NewChat => {
            show_main_window(app)?;
            emit_desktop_shell_event(app, action, source)
        }
        DesktopShellAction::OpenSettings => {
            show_main_window(app)?;
            emit_desktop_shell_event(app, action, source)
        }
        DesktopShellAction::OpenHelp => {
            show_main_window(app)?;
            emit_desktop_shell_event(app, action, source)
        }
        DesktopShellAction::ImportClipboard => {
            show_main_window(app)?;
            trigger_clipboard_import(app, source);
            Ok(())
        }
        DesktopShellAction::Quit => {
            app.exit(0);
            Ok(())
        }
    }
}

fn emit_desktop_shell_event<R: Runtime>(
    app: &AppHandle<R>,
    action: DesktopShellAction,
    source: &'static str,
) -> anyhow::Result<()> {
    emit_desktop_shell_payload(
        app,
        DesktopShellActionPayload {
            action: action.as_str(),
            source,
            clipboard_items: None,
            error: None,
        },
    )
}

fn emit_desktop_shell_payload<R: Runtime>(
    app: &AppHandle<R>,
    payload: DesktopShellActionPayload,
) -> anyhow::Result<()> {
    app.emit(
        DESKTOP_ACTION_EVENT,
        payload,
    )?;
    Ok(())
}

fn trigger_clipboard_import<R: Runtime>(app: &AppHandle<R>, source: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let payload = build_clipboard_import_payload(&app, source);
        if let Err(err) = emit_desktop_shell_payload(&app, payload) {
            tracing::error!("failed to emit clipboard import payload: {err:#}");
        }
    });
}

fn build_clipboard_import_payload<R: Runtime>(
    app: &AppHandle<R>,
    source: &'static str,
) -> DesktopShellActionPayload {
    match read_clipboard_items(app) {
        Ok(items) if !items.is_empty() => DesktopShellActionPayload {
            action: DesktopShellAction::ImportClipboard.as_str(),
            source,
            clipboard_items: Some(items),
            error: None,
        },
        Ok(_) => DesktopShellActionPayload {
            action: DesktopShellAction::ImportClipboard.as_str(),
            source,
            clipboard_items: None,
            error: Some("剪贴板里没有可导入的文本或图片。".to_string()),
        },
        Err(err) => DesktopShellActionPayload {
            action: DesktopShellAction::ImportClipboard.as_str(),
            source,
            clipboard_items: None,
            error: Some(format!("读取剪贴板失败：{err}")),
        },
    }
}

fn read_clipboard_items<R: Runtime>(
    app: &AppHandle<R>,
) -> anyhow::Result<Vec<DesktopClipboardItemPayload>> {
    let clipboard = app.clipboard();
    let mut items = Vec::new();

    if let Ok(text) = clipboard.read_text() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            items.push(DesktopClipboardItemPayload {
                kind: "text",
                text: Some(trimmed.to_string()),
                mime: Some("text/plain"),
                name: None,
                data_b64: None,
                width: None,
                height: None,
            });
        }
    }

    if let Ok(image) = clipboard.read_image() {
        let width = image.width();
        let height = image.height();
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(image.rgba(), width, height, ColorType::Rgba8.into())
            .map_err(|err| anyhow!("encode clipboard image: {err}"))?;
        items.push(DesktopClipboardItemPayload {
            kind: "image",
            text: None,
            mime: Some("image/png"),
            name: Some("clipboard-image.png".to_string()),
            data_b64: Some(BASE64_STANDARD.encode(png)),
            width: Some(width),
            height: Some(height),
        });
    }

    Ok(items)
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("toggle_window", "显示 / 隐藏 Taori")
        .text("new_chat", "新对话")
        .text("import_clipboard", "导入剪贴板（截图 / 文本）")
        .separator()
        .text("open_settings", "打开设置")
        .text("open_help", "使用帮助")
        .separator()
        .text("quit", "退出 Taori")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("taori-main-tray")
        .menu(&menu)
        .tooltip(format!(
            "Taori\n{} 显示 / 隐藏\n{} 新对话\n{} 导入剪贴板",
            DESKTOP_SHORTCUT_TOGGLE, DESKTOP_SHORTCUT_NEW_CHAT, DESKTOP_SHORTCUT_IMPORT_CLIPBOARD
        ))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "toggle_window" => Some(DesktopShellAction::ToggleWindow),
                "new_chat" => Some(DesktopShellAction::NewChat),
                "import_clipboard" => Some(DesktopShellAction::ImportClipboard),
                "open_settings" => Some(DesktopShellAction::OpenSettings),
                "open_help" => Some(DesktopShellAction::OpenHelp),
                "quit" => Some(DesktopShellAction::Quit),
                _ => None,
            };
            if let Some(action) = action {
                if let Err(err) = handle_desktop_shell_action(app, action, "tray_menu") {
                    tracing::error!("tray menu action failed: {err:#}");
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(err) =
                    handle_desktop_shell_action(&tray.app_handle().clone(), DesktopShellAction::ToggleWindow, "tray_click")
                {
                    tracing::error!("tray click action failed: {err:#}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn register_desktop_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app
        .global_shortcut()
        .register(DESKTOP_SHORTCUT_TOGGLE)
    {
        tracing::warn!(
            "failed to register desktop shortcut {}: {}",
            DESKTOP_SHORTCUT_TOGGLE,
            err
        );
    }
    if let Err(err) = app
        .global_shortcut()
        .register(DESKTOP_SHORTCUT_NEW_CHAT)
    {
        tracing::warn!(
            "failed to register desktop shortcut {}: {}",
            DESKTOP_SHORTCUT_NEW_CHAT,
            err
        );
    }
    if let Err(err) = app
        .global_shortcut()
        .register(DESKTOP_SHORTCUT_IMPORT_CLIPBOARD)
    {
        tracing::warn!(
            "failed to register desktop shortcut {}: {}",
            DESKTOP_SHORTCUT_IMPORT_CLIPBOARD,
            err
        );
    }
}

fn handle_main_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(err) = window.hide() {
            tracing::error!("failed to hide main window on close request: {err}");
        }
    }
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<tauri::WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| anyhow!("main webview window is not ready"))
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    let window = main_window(app)?;
    if window.is_visible()? {
        window.hide()?;
        return Ok(());
    }
    show_webview_window(&window)
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    let window = main_window(app)?;
    show_webview_window(&window)
}

fn show_webview_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> anyhow::Result<()> {
    if let Ok(true) = window.is_minimized() {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

impl DesktopShellAction {
    fn as_str(self) -> &'static str {
        match self {
            DesktopShellAction::ToggleWindow => "toggle-window",
            DesktopShellAction::ShowWindow => "show-window",
            DesktopShellAction::NewChat => "new-chat",
            DesktopShellAction::OpenSettings => "open-settings",
            DesktopShellAction::OpenHelp => "open-help",
            DesktopShellAction::ImportClipboard => "import-clipboard",
            DesktopShellAction::Quit => "quit",
        }
    }
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
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let action = if shortcut.to_string() == DESKTOP_SHORTCUT_TOGGLE {
                        Some(DesktopShellAction::ToggleWindow)
                    } else if shortcut.to_string() == DESKTOP_SHORTCUT_NEW_CHAT {
                        Some(DesktopShellAction::NewChat)
                    } else if shortcut.to_string() == DESKTOP_SHORTCUT_IMPORT_CLIPBOARD {
                        Some(DesktopShellAction::ImportClipboard)
                    } else {
                        None
                    };
                    if let Some(action) = action {
                        if let Err(err) =
                            handle_desktop_shell_action(app, action, "global_shortcut")
                        {
                            tracing::error!("desktop shortcut action failed: {err:#}");
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![sidecar_endpoint, control_health, import_clipboard])
        .on_window_event(handle_main_window_event)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let automation_handle = app.handle().clone();
            let state = app_state.clone();
            let control_url_for_spawn = control_url.clone();
            let control_bearer_for_spawn = control_bearer.clone();
            if let Err(err) = build_tray(&app_handle) {
                tracing::warn!("desktop tray unavailable: {err:#}");
            }
            register_desktop_shortcuts(&app_handle);
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
