use std::time::Duration;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::K32EmptyWorkingSet;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
};

/// Trims working set memory of the current process and all child WebView2 helper processes
pub fn trim_memory() {
    unsafe {
        let current_handle = GetCurrentProcess();
        let _ = K32EmptyWorkingSet(current_handle);

        let current_pid = GetCurrentProcessId();
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(s) => s,
            Err(_) => return,
        };

        let mut entries = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        // Find all descendants (children and grandchildren of WebView2)
        let mut target_pids = std::collections::HashSet::new();
        let mut queue = vec![current_pid];

        while let Some(parent) = queue.pop() {
            for &(pid, ppid) in &entries {
                if ppid == parent && target_pids.insert(pid) {
                    queue.push(pid);
                }
            }
        }

        // Trim working set on all discovered descendant processes (browser, gpu, renderer)
        for pid in target_pids {
            if let Ok(child_h) = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA,
                false,
                pid,
            ) {
                let _ = K32EmptyWorkingSet(child_h);
                let _ = CloseHandle(child_h);
            }
        }
    }
}

/// Starts a background thread that periodically trims unused memory
pub fn start_memory_trimmer() {
    std::thread::spawn(|| {
        // Initial grace period for app and WebView2 startup
        std::thread::sleep(Duration::from_secs(5));
        trim_memory();

        loop {
            std::thread::sleep(Duration::from_secs(45));
            trim_memory();
        }
    });
}
