use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Only these programs may ever be spawned by the webview. Everything else is
/// refused in `resolve_program`, so the frontend cannot widen the surface.
const ALLOWED_PROGRAMS: [&str; 4] = ["ado-stack", "git", "claude", "codex"];

#[derive(Default)]
struct Jobs(Mutex<HashMap<String, Child>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgramInfo {
    name: String,
    path: String,
    source: String, // "path" | "sidecar"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    ado_stack: Option<ProgramInfo>,
    git: Option<ProgramInfo>,
    agents: Vec<ProgramInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobOutput {
    id: String,
    stream: String,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobExit {
    id: String,
    code: i32,
}

fn executable_candidates(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in executable_candidates(name) {
            let full = dir.join(&candidate);
            if is_executable_file(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match path.metadata() {
            Ok(meta) => meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The bundled CLI sidecar sits next to the app executable at runtime.
fn sidecar_ado_stack() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for candidate in executable_candidates("ado-stack") {
        let full = dir.join(candidate);
        if is_executable_file(&full) {
            return Some(full);
        }
    }
    None
}

fn resolve_ado_stack() -> Option<(PathBuf, &'static str)> {
    if let Some(found) = find_on_path("ado-stack") {
        return Some((found, "path"));
    }
    sidecar_ado_stack().map(|found| (found, "sidecar"))
}

fn resolve_program(name: &str) -> Result<PathBuf, String> {
    if !ALLOWED_PROGRAMS.contains(&name) {
        return Err(format!("`{name}` is not an allowed program."));
    }
    if name == "ado-stack" {
        return resolve_ado_stack().map(|(path, _)| path).ok_or_else(|| {
            "ado-stack was not found on PATH and no bundled copy is available.".to_string()
        });
    }
    find_on_path(name).ok_or_else(|| format!("`{name}` was not found on PATH."))
}

fn base_command(program: &str, args: &[String], cwd: &str) -> Result<Command, String> {
    let resolved = resolve_program(program)?;
    if !Path::new(cwd).is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }
    let mut cmd = Command::new(resolved);
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("ADO_STACK_NO_TUI", "1")
        .env("ADO_STACK_NO_UPDATE_CHECK", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

#[tauri::command]
fn detect_environment() -> EnvInfo {
    let ado_stack = resolve_ado_stack().map(|(path, source)| ProgramInfo {
        name: "ado-stack".to_string(),
        path: path.to_string_lossy().to_string(),
        source: source.to_string(),
    });
    let git = find_on_path("git").map(|path| ProgramInfo {
        name: "git".to_string(),
        path: path.to_string_lossy().to_string(),
        source: "path".to_string(),
    });
    let agents = ["claude", "codex"]
        .iter()
        .filter_map(|name| {
            find_on_path(name).map(|path| ProgramInfo {
                name: (*name).to_string(),
                path: path.to_string_lossy().to_string(),
                source: "path".to_string(),
            })
        })
        .collect();
    EnvInfo {
        ado_stack,
        git,
        agents,
    }
}

#[tauri::command]
fn run_capture(
    program: String,
    args: Vec<String>,
    cwd: String,
    stdin: Option<String>,
) -> Result<CaptureResult, String> {
    let mut cmd = base_command(&program, &args, &cwd)?;
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input.as_bytes())
                .map_err(|error| error.to_string())?;
        }
    }
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_string(&mut stdout).ok();
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_string(&mut stderr).ok();
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    Ok(CaptureResult {
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

fn stream_lines(
    app: AppHandle,
    id: String,
    stream_name: &'static str,
    reader: impl Read + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            let Ok(line) = line else { break };
            let _ = app.emit(
                "job-output",
                JobOutput {
                    id: id.clone(),
                    stream: stream_name.to_string(),
                    line,
                },
            );
        }
    })
}

#[tauri::command]
fn start_job(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    {
        let held = jobs.0.lock().map_err(|_| "job registry poisoned")?;
        if held.contains_key(&id) {
            return Err(format!("Job `{id}` is already running."));
        }
    }
    let mut cmd = base_command(&program, &args, &cwd)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        readers.push(stream_lines(app.clone(), id.clone(), "stdout", pipe));
    }
    if let Some(pipe) = stderr {
        readers.push(stream_lines(app.clone(), id.clone(), "stderr", pipe));
    }
    jobs.0
        .lock()
        .map_err(|_| "job registry poisoned")?
        .insert(id.clone(), child);
    let waiter_app = app.clone();
    thread::spawn(move || {
        let code = loop {
            {
                let state = waiter_app.state::<Jobs>();
                let mut held = match state.0.lock() {
                    Ok(held) => held,
                    Err(_) => break -1,
                };
                match held.get_mut(&id) {
                    None => break -1,
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            held.remove(&id);
                            break status.code().unwrap_or(-1);
                        }
                        Ok(None) => {}
                        Err(_) => {
                            held.remove(&id);
                            break -1;
                        }
                    },
                }
            }
            thread::sleep(Duration::from_millis(80));
        };
        for reader in readers {
            let _ = reader.join();
        }
        let _ = waiter_app.emit("job-exit", JobExit { id, code });
    });
    Ok(())
}

#[tauri::command]
fn kill_job(jobs: State<'_, Jobs>, id: String) -> Result<bool, String> {
    let mut held = jobs.0.lock().map_err(|_| "job registry poisoned")?;
    match held.get_mut(&id) {
        Some(child) => {
            child.kill().map_err(|error| error.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![
            detect_environment,
            run_capture,
            start_job,
            kill_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running ado-stack desktop");
}
