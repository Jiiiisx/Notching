// Standalone probe replicating game_detector.rs's exact UIA (IUIAutomation) tab-avoidance path.
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, TreeScope_Children, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetTopWindow, GetWindow, GetWindowTextW, IsWindowVisible, GW_HWNDNEXT,
};

fn find_brave_window() -> Option<HWND> {
    unsafe {
        let mut hwnd = GetTopWindow(None).ok()?;
        let mut steps = 0;
        while !hwnd.is_invalid() && steps < 300 {
            steps += 1;
            if IsWindowVisible(hwnd).as_bool() {
                let mut buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut buf);
                let title = String::from_utf16_lossy(&buf[..len as usize]);
                if title.contains("Brave") {
                    return Some(hwnd);
                }
            }
            hwnd = GetWindow(hwnd, GW_HWNDNEXT).ok()?;
        }
    }
    None
}

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let auto: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        {
            Ok(a) => a,
            Err(e) => {
                println!("NO_AUTOMATION {e}");
                return;
            }
        };
        let Some(hwnd) = find_brave_window() else {
            println!("NO_BRAVE_WINDOW");
            return;
        };

        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL);
        let mut mi =
            MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(hmon, &mut mi);
        let cx = (mi.rcMonitor.left + mi.rcMonitor.right) / 2;
        let notch_half = 210; // logical half-width approx, scale 1.0-ish
        let safety = 14;
        let notch_left = cx - notch_half - safety;
        let notch_right = cx + notch_half + safety;
        println!(
            "MONITOR mon=({},{})-({},{}) work.top={} cx={} zone=[{notch_left},{notch_right}]",
            mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom,
            mi.rcWork.top, cx
        );

        let Ok(elem) = auto.ElementFromHandle(hwnd) else { println!("ELEM_FAIL"); return; };

        // strips
        let var_strip = VARIANT::from(UIA_TabControlTypeId.0 as i32);
        let Ok(cond_strip) = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_strip)
        else {
            println!("COND_FAIL");
            return;
        };
        match elem.FindAll(TreeScope_Descendants, &cond_strip) {
            Ok(strips) => {
                let n = strips.Length().unwrap_or(0);
                println!("TAB_STRIPS={n}");
                for i in 0..n {
                    let Ok(s) = strips.GetElement(i) else { continue };
                    let Ok(r) = s.CurrentBoundingRectangle() else { continue };
                    let cls = s.CurrentClassName().unwrap_or_default();
                    let id = s.CurrentAutomationId().unwrap_or_default();
                    println!(
                        "STRIP[{i}] class={:?} id={:?} rect=({},{})-({},{})",
                        cls.to_string(),
                        id.to_string(),
                        r.left, r.top, r.right, r.bottom
                    );
                    let var_item = VARIANT::from(UIA_TabItemControlTypeId.0 as i32);
                    if let Ok(cond_item) =
                        auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_item)
                    {
                        if let Ok(items) = s.FindAll(TreeScope_Children, &cond_item) {
                            let cn = items.Length().unwrap_or(0);
                            println!("  CHILD_ITEMS={cn}");
                            for j in 0..cn {
                                if let Ok(it) = items.GetElement(j) {
                                    if let Ok(ir) = it.CurrentBoundingRectangle() {
                                        let nm = it.CurrentName().unwrap_or_default();
                                        let overlap = ir.right >= notch_left && ir.left <= notch_right;
                                        println!(
                                            "  ITEM[{j}] name={:?} rect=({},{})-({},{}) overlap={}",
                                            nm.to_string().chars().take(30).collect::<String>(),
                                            ir.left, ir.top, ir.right, ir.bottom, overlap
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => println!("STRIPS_FAIL {e}"),
        }

        // fallback: TabItems anywhere
        let var_item = VARIANT::from(UIA_TabItemControlTypeId.0 as i32);
        if let Ok(cond_item) = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_item) {
            match elem.FindAll(TreeScope_Descendants, &cond_item) {
                Ok(items) => {
                    let n = items.Length().unwrap_or(0);
                    let mut near_top = 0;
                    let mut overlapping = 0;
                    for i in 0..n {
                        if let Ok(it) = items.GetElement(i) {
                            if let Ok(ir) = it.CurrentBoundingRectangle() {
                                if ir.top >= mi.rcMonitor.top && ir.top <= mi.rcMonitor.top + 52 {
                                    near_top += 1;
                                    if ir.right >= notch_left && ir.left <= notch_right {
                                        overlapping += 1;
                                    }
                                    if near_top <= 8 {
                                        let nm = it.CurrentName().unwrap_or_default();
                                        println!(
                                            "FALLBACK_ITEM[{i}] name={:?} rect=({},{})-({},{})",
                                            nm.to_string().chars().take(30).collect::<String>(),
                                            ir.left, ir.top, ir.right, ir.bottom
                                        );
                                    }
                                }
                            }
                        }
                    }
                    println!("FALLBACK_TOTAL={n} near_top={near_top} overlapping_with_zone={overlapping}");
                }
                Err(e) => println!("FALLBACK_FAIL {e}"),
            }
        }
    }
}
