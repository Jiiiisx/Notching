use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use windows::core::Interface;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStats {
    pub cpu_usage: f32,       // 0.0 - 100.0%
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub ram_avail_mb: u64,
    pub ram_percent: f32,
    pub gpu_name: String,
    pub vram_total_mb: u64,
    pub vram_used_mb: u64,
    pub vram_percent: f32,
    pub net_down_bps: u64,    // bytes per second
    pub net_up_bps: u64,      // bytes per second
    pub uptime_secs: u64,
}

#[derive(Default)]
struct PreviousSample {
    timestamp: Option<Instant>,
    idle_time: u64,
    kernel_time: u64,
    user_time: u64,
    net_in_octets: u64,
    net_out_octets: u64,
}

pub struct SystemMonitor {
    sample: Mutex<PreviousSample>,
}

fn filetime_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

impl SystemMonitor {
    pub fn new() -> Arc<Self> {
        let monitor = Arc::new(Self {
            sample: Mutex::new(PreviousSample::default()),
        });
        // Initial sample so next call has a delta
        let _ = monitor.get_stats();
        monitor
    }

    pub fn get_stats(&self) -> SystemStats {
        let now = Instant::now();

        // 1. CPU Usage via GetSystemTimes
        let mut idle_ft = FILETIME::default();
        let mut kernel_ft = FILETIME::default();
        let mut user_ft = FILETIME::default();
        let _ = unsafe { GetSystemTimes(Some(&mut idle_ft), Some(&mut kernel_ft), Some(&mut user_ft)) };

        let curr_idle = filetime_to_u64(idle_ft);
        let curr_kernel = filetime_to_u64(kernel_ft);
        let curr_user = filetime_to_u64(user_ft);

        // 2. RAM Usage via GlobalMemoryStatusEx
        let mut mem_status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        let _ = unsafe { GlobalMemoryStatusEx(&mut mem_status) };
        let ram_total_mb = mem_status.ullTotalPhys / (1024 * 1024);
        let ram_avail_mb = mem_status.ullAvailPhys / (1024 * 1024);
        let ram_used_mb = ram_total_mb.saturating_sub(ram_avail_mb);
        let ram_percent = if ram_total_mb > 0 {
            (ram_used_mb as f32 / ram_total_mb as f32) * 100.0
        } else {
            mem_status.dwMemoryLoad as f32
        };

        // 3. Network Octets via GetIfTable2
        let mut total_in_octets = 0u64;
        let mut total_out_octets = 0u64;
        let mut table_ptr: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if unsafe { GetIfTable2(&mut table_ptr) }.is_ok() && !table_ptr.is_null() {
            unsafe {
                let table = &*table_ptr;
                let rows = std::slice::from_raw_parts(
                    table.Table.as_ptr(),
                    table.NumEntries as usize,
                );
                for row in rows {
                    // Type: 6 = Ethernet, 71 = IEEE 802.11 WiFi, 24 = Loopback
                    if row.Type != 24 && row.OperStatus.0 == 1 {
                        total_in_octets += row.InOctets;
                        total_out_octets += row.OutOctets;
                    }
                }
                FreeMibTable(table_ptr as *const _);
            }
        }

        // Calculate Deltas with Previous Sample
        let mut prev = self.sample.lock().unwrap();

        let (cpu_usage, net_down_bps, net_up_bps) = match prev.timestamp {
            Some(prev_time) => {
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                let effective_elapsed = if elapsed > 0.05 { elapsed } else { 1.0 };

                // CPU Delta
                let idle_diff = curr_idle.saturating_sub(prev.idle_time);
                let kernel_diff = curr_kernel.saturating_sub(prev.kernel_time);
                let user_diff = curr_user.saturating_sub(prev.user_time);
                let total_diff = kernel_diff + user_diff;

                let cpu = if total_diff > 0 {
                    let busy = total_diff.saturating_sub(idle_diff);
                    ((busy as f32 / total_diff as f32) * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };

                // Network throughput (Bytes per second)
                let down = (curr_in_delta(total_in_octets, prev.net_in_octets) as f64 / effective_elapsed) as u64;
                let up = (curr_in_delta(total_out_octets, prev.net_out_octets) as f64 / effective_elapsed) as u64;

                (cpu, down, up)
            }
            None => (0.0, 0, 0),
        };

        // Update previous state
        prev.timestamp = Some(now);
        prev.idle_time = curr_idle;
        prev.kernel_time = curr_kernel;
        prev.user_time = curr_user;
        prev.net_in_octets = total_in_octets;
        prev.net_out_octets = total_out_octets;
        drop(prev);

        // 4. GPU & VRAM via DXGI
        let (gpu_name, vram_total_mb, vram_used_mb, vram_percent) = get_gpu_vram_info();

        // 5. System Uptime
        let uptime_secs = unsafe { GetTickCount64() } / 1000;

        SystemStats {
            cpu_usage: (cpu_usage * 10.0).round() / 10.0,
            ram_total_mb,
            ram_used_mb,
            ram_avail_mb,
            ram_percent: (ram_percent * 10.0).round() / 10.0,
            gpu_name,
            vram_total_mb,
            vram_used_mb,
            vram_percent: (vram_percent * 10.0).round() / 10.0,
            net_down_bps,
            net_up_bps,
            uptime_secs,
        }
    }
}

fn curr_in_delta(curr: u64, prev: u64) -> u64 {
    if curr >= prev {
        curr - prev
    } else {
        0
    }
}

fn get_gpu_vram_info() -> (String, u64, u64, f32) {
    unsafe {
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            let mut best_adapter: Option<(String, u64, u64, f32)> = None;

            for i in 0..8 {
                if let Ok(adapter) = factory.EnumAdapters1(i) {
                    if let Ok(desc) = adapter.GetDesc1() {
                        let name = String::from_utf16_lossy(&desc.Description)
                            .trim_matches('\0')
                            .to_string();

                        // Skip software rasterizers (Microsoft Basic Render Driver)
                        if desc.Flags & 2 != 0 || name.contains("Basic Render") {
                            continue;
                        }

                        let dedicated_mb = (desc.DedicatedVideoMemory / (1024 * 1024)) as u64;
                        let shared_mb = (desc.SharedSystemMemory / (1024 * 1024)) as u64;

                        let mut used_mb = 0u64;
                        let mut total_mb = dedicated_mb;
                        if total_mb == 0 {
                            total_mb = shared_mb;
                        }

                        if let Ok(adapter3) = adapter.cast::<IDXGIAdapter3>() {
                            let mut local_info = Default::default();
                            if adapter3
                                .QueryVideoMemoryInfo(
                                    0,
                                    DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
                                    &mut local_info,
                                )
                                .is_ok()
                            {
                                used_mb = (local_info.CurrentUsage / (1024 * 1024)) as u64;
                                let local_budget = (local_info.Budget / (1024 * 1024)) as u64;
                                if total_mb == 0 && local_budget > 0 {
                                    total_mb = local_budget;
                                }
                            }
                        }

                        let pct = if total_mb > 0 {
                            ((used_mb as f32 / total_mb as f32) * 100.0).clamp(0.0, 100.0)
                        } else {
                            0.0
                        };

                        // Prefer dedicated/discrete or AMD GPU with high VRAM
                        let candidate = (name, total_mb, used_mb, pct);
                        if best_adapter.is_none() || total_mb > best_adapter.as_ref().unwrap().1 {
                            best_adapter = Some(candidate);
                        }
                    }
                } else {
                    break;
                }
            }

            if let Some(res) = best_adapter {
                return res;
            }
        }
    }

    ("GPU".to_string(), 0, 0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_stats() {
        let monitor = SystemMonitor::new();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let stats = monitor.get_stats();
        println!("Test Stats: {:#?}", stats);
        assert!(stats.ram_total_mb > 0);
        assert!(stats.ram_percent > 0.0);
    }
}
