//! Headless end-to-end check of published runtime assets. Uses an isolated data
//! directory, without starting or stopping the installed desktop application.
//! cargo run --example runtime-install -- <bootstrap.json> <scratch-data-dir>
#![allow(dead_code)]
#[path = "../src/backend.rs"]
mod backend;
#[path = "../src/runtime.rs"]
mod runtime;
#[path = "../src/server_log.rs"]
mod server_log;

fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err("usage: runtime-install <bootstrap.json> <scratch-data-dir>".into());
    }
    let data = std::path::PathBuf::from(&args[2]);
    let manifest = runtime::Manifest::read(std::path::Path::new(&args[1]))?;
    let state = runtime::RuntimeState::default();
    let directory = runtime::install(&manifest, &data, &state)?;
    // A cancelled installer can still hit a complete offline cache: there must
    // be no subprocess or network request on the second call.
    state.cancel();
    assert_eq!(directory, runtime::install(&manifest, &data, &state)?);
    let (mut backend, ready) = backend::Backend::spawn(
        &directory.join("node"),
        &directory.join("server/dist/main.js"),
        &directory.join("web"),
        &data,
    )
    .map_err(|e| e.message().to_string())?;
    println!(
        "Installed, offline cache reused, backend handshake ready: {}",
        ready.url
    );
    backend.shutdown();
    Ok(())
}
