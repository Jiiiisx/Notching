use serde::Serialize;

#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct SystemPowerStatus {
    pub ac_line_status: u8, // 0 = offline, 1 = online (charging/plugged in), 255 = unknown
    pub battery_flag: u8,
    pub battery_life_percent: u8, // 0-100, 255 = unknown
    pub system_status_flag: u8,
    pub battery_life_time: u32,
    pub battery_full_life_time: u32,
}

unsafe extern "system" {
    fn GetSystemPowerStatus(lpSystemPowerStatus: *mut SystemPowerStatus) -> i32;
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BatteryInfo {
    pub has_battery: bool,
    pub percent: u8,
    pub is_charging: bool,
}

pub fn get_battery_status() -> BatteryInfo {
    let mut status = SystemPowerStatus::default();
    let success = unsafe { GetSystemPowerStatus(&mut status) } != 0;

    if success && status.battery_life_percent <= 100 && status.battery_flag != 128 {
        BatteryInfo {
            has_battery: true,
            percent: status.battery_life_percent,
            is_charging: status.ac_line_status == 1,
        }
    } else {
        BatteryInfo {
            has_battery: false,
            percent: 100,
            is_charging: false,
        }
    }
}
