//! Sidecar process lifecycle.
//!
//! Dev:  set TAORI_DEV_SIDECAR_CMD="node /abs/apps/sidecar/dist/index.js" (or
//!       similar). The launcher script `pnpm dev:desktop` should `pnpm build:sidecar`
//!       first and then export this env.
//! Prod: an `apps/desktop/src-tauri/binaries/taori-sidecar-<triple>` is bundled
//!       via Tauri sidecar mechanism. (Not done in M0.)
//!
//! Lifecycle: the child is monitored; on unexpected exit we log. M0 does not
//! auto-restart yet (M1 will).

use std::process::Stdio;

use anyhow::{anyhow, Context};
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

use crate::SidecarEndpoint;

pub async fn spawn_sidecar(
    _app: &AppHandle,
    control_url: &str,
    control_bearer: &str,
) -> anyhow::Result<SidecarEndpoint> {
    let cmd_str = std::env::var("TAORI_DEV_SIDECAR_CMD")
        .map_err(|_| anyhow!("TAORI_DEV_SIDECAR_CMD not set; M0 only supports dev sidecar"))?;
    let mut parts = shell_split(&cmd_str)?.into_iter();
    let program = parts
        .next()
        .ok_or_else(|| anyhow!("empty TAORI_DEV_SIDECAR_CMD"))?;
    let args: Vec<String> = parts.collect();

    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("CONTROL_URL", control_url)
        .env("CONTROL_BEARER", control_bearer)
        .env("NODE_ENV", "development")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().context("spawn sidecar")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("sidecar stdout not captured"))?;
    let mut reader = BufReader::new(stdout).lines();

    // First (and only first) line must be "READY <port> <bearer>".
    let line = tokio::time::timeout(std::time::Duration::from_secs(15), reader.next_line())
        .await
        .map_err(|_| anyhow!("timed out waiting for sidecar READY line"))?
        .context("read sidecar stdout")?
        .ok_or_else(|| anyhow!("sidecar closed stdout before READY"))?;

    let endpoint = parse_ready_line(&line)?;

    // Drain remaining stdout to logs (so a noisy sidecar can't deadlock its pipe).
    tokio::spawn(async move {
        while let Ok(Some(l)) = reader.next_line().await {
            tracing::debug!("sidecar.stdout: {}", l);
        }
    });

    // Watch for child exit so we can log it.
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => tracing::warn!("sidecar exited: {}", status),
            Err(e) => tracing::error!("sidecar wait error: {}", e),
        }
    });

    Ok(endpoint)
}

fn parse_ready_line(line: &str) -> anyhow::Result<SidecarEndpoint> {
    let mut it = line.split_whitespace();
    let tag = it.next().unwrap_or("");
    if tag != "READY" {
        return Err(anyhow!("expected READY line, got: {line}"));
    }
    let port: u16 = it
        .next()
        .ok_or_else(|| anyhow!("missing port"))?
        .parse()
        .context("parse port")?;
    let bearer = it
        .next()
        .ok_or_else(|| anyhow!("missing bearer"))?
        .to_string();
    Ok(SidecarEndpoint {
        url: format!("http://127.0.0.1:{}", port),
        bearer,
    })
}

/// Naive shell split: splits on whitespace, supports double-quoted segments.
fn shell_split(s: &str) -> anyhow::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if in_quote {
        return Err(anyhow!("unmatched quote in TAORI_DEV_SIDECAR_CMD"));
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}
