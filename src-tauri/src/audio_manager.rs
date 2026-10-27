use serde::{Deserialize, Serialize};
use windows::core::{GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToString};
use windows::Win32::System::Com::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceItem {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioStatus {
    pub master_volume: f32, // 0.0 - 1.0
    pub is_muted: bool,
    pub output_devices: Vec<AudioDeviceItem>,
    pub input_devices: Vec<AudioDeviceItem>,
    pub current_output_id: Option<String>,
    pub current_output_name: Option<String>,
    pub current_input_id: Option<String>,
    pub current_input_name: Option<String>,
}

const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

// COM interface definition for IPolicyConfig (Windows 10/11)
// CLSID: 870af99c-171d-4f9e-af0d-e63df40c2bc9
// IID:   f8679f50-850a-41cf-9c72-430f290290c8
const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

#[allow(non_snake_case)]
#[repr(C)]
pub struct IPolicyConfigVtbl {
    pub base__: windows::core::IUnknown_Vtbl,
    pub GetMixFormat: usize,
    pub GetDeviceFormat: usize,
    pub ResetDeviceFormat: usize,
    pub SetDeviceFormat: usize,
    pub GetProcessingPeriod: usize,
    pub SetProcessingPeriod: usize,
    pub GetShareMode: usize,
    pub SetShareMode: usize,
    pub GetPropertyValue: usize,
    pub SetPropertyValue: usize,
    pub SetDefaultEndpoint: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        PCWSTR,
        u32,
    ) -> HRESULT,
    pub SetEndpointVisibility: usize,
}

#[repr(transparent)]
#[derive(Clone, PartialEq, Eq)]
pub struct IPolicyConfig(windows::core::IUnknown);

unsafe impl windows::core::Interface for IPolicyConfig {
    type Vtable = IPolicyConfigVtbl;
    const IID: windows::core::GUID = windows::core::GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
}

fn get_device_friendly_name(device: &IMMDevice) -> String {
    unsafe {
        if let Ok(store) = device.OpenPropertyStore(STGM_READ) {
            if let Ok(mut propvar) = store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME) {
                let mut buffer = [0u16; 256];
                if PropVariantToString(&propvar, &mut buffer).is_ok() {
                    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                    let name = String::from_utf16_lossy(&buffer[..len]);
                    let _ = PropVariantClear(&mut propvar);
                    if !name.trim().is_empty() {
                        return name;
                    }
                }
                let _ = PropVariantClear(&mut propvar);
            }
        }
    }
    "Unknown Audio Device".to_string()
}

pub fn get_audio_status() -> Result<AudioStatus, Box<dyn std::error::Error>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

        // Default render device (output)
        let default_output = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok();
        let current_output_id = default_output
            .as_ref()
            .and_then(|d| d.GetId().ok())
            .map(|id| id.to_string().unwrap_or_default());
        let current_output_name = default_output.as_ref().map(get_device_friendly_name);

        // Volume & Mute from default output
        let mut master_volume = 1.0f32;
        let mut is_muted = false;
        if let Some(ref dev) = default_output {
            if let Ok(vol_ctl) = dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                if let Ok(v) = vol_ctl.GetMasterVolumeLevelScalar() {
                    master_volume = v;
                }
                if let Ok(m) = vol_ctl.GetMute() {
                    is_muted = m.as_bool();
                }
            }
        }

        // Default capture device (input/mic)
        let default_input = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok();
        let current_input_id = default_input
            .as_ref()
            .and_then(|d| d.GetId().ok())
            .map(|id| id.to_string().unwrap_or_default());
        let current_input_name = default_input.as_ref().map(get_device_friendly_name);

        // Enumerate active output devices
        let mut output_devices = Vec::new();
        if let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
            let count = collection.GetCount().unwrap_or(0);
            for i in 0..count {
                if let Ok(dev) = collection.Item(i) {
                    if let Ok(id_pwstr) = dev.GetId() {
                        let id_str = id_pwstr.to_string().unwrap_or_default();
                        let name = get_device_friendly_name(&dev);
                        let is_default = current_output_id.as_deref() == Some(&id_str);
                        output_devices.push(AudioDeviceItem {
                            id: id_str,
                            name,
                            is_default,
                        });
                    }
                }
            }
        }

        // Enumerate active input devices
        let mut input_devices = Vec::new();
        if let Ok(collection) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) {
            let count = collection.GetCount().unwrap_or(0);
            for i in 0..count {
                if let Ok(dev) = collection.Item(i) {
                    if let Ok(id_pwstr) = dev.GetId() {
                        let id_str = id_pwstr.to_string().unwrap_or_default();
                        let name = get_device_friendly_name(&dev);
                        let is_default = current_input_id.as_deref() == Some(&id_str);
                        input_devices.push(AudioDeviceItem {
                            id: id_str,
                            name,
                            is_default,
                        });
                    }
                }
            }
        }

        Ok(AudioStatus {
            master_volume,
            is_muted,
            output_devices,
            input_devices,
            current_output_id,
            current_output_name,
            current_input_id,
            current_input_name,
        })
    }
}

pub fn set_master_volume(level: f32) -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let vol_ctl: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?;
        let clamped = level.clamp(0.0, 1.0);
        vol_ctl.SetMasterVolumeLevelScalar(clamped, std::ptr::null())?;
        if clamped > 0.0 {
            if let Ok(m) = vol_ctl.GetMute() {
                if m.as_bool() {
                    let _ = vol_ctl.SetMute(false, std::ptr::null());
                }
            }
        }
        Ok(())
    }
}

pub fn set_master_mute(mute: bool) -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let vol_ctl: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?;
        vol_ctl.SetMute(mute, std::ptr::null())?;
        Ok(())
    }
}

pub fn set_default_device(device_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let policy_client: IPolicyConfig =
            CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)?;

        let wide_id: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
        let pcwstr = PCWSTR(wide_id.as_ptr());

        // eConsole = 0, eMultimedia = 1, eCommunications = 2
        for role in [0u32, 1u32, 2u32] {
            let hr = (windows::core::Interface::vtable(&policy_client).SetDefaultEndpoint)(
                windows::core::Interface::as_raw(&policy_client),
                pcwstr,
                role,
            );
            if hr.is_err() {
                eprintln!("[set_default_device] Failed for role {}: {:?}", role, hr);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickVolumeInfo {
    pub volume: f32,
    pub is_muted: bool,
    pub output_id: String,
    pub output_name: String,
}

pub fn get_quick_volume_info() -> Result<QuickVolumeInfo, Box<dyn std::error::Error>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let default_output = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let output_id = default_output
            .GetId()?
            .to_string()
            .unwrap_or_default();
        let output_name = get_device_friendly_name(&default_output);
        let vol_ctl: IAudioEndpointVolume = default_output.Activate(CLSCTX_ALL, None)?;
        let volume = vol_ctl.GetMasterVolumeLevelScalar().unwrap_or(1.0);
        let is_muted = vol_ctl.GetMute().map(|m| m.as_bool()).unwrap_or(false);
        Ok(QuickVolumeInfo {
            volume,
            is_muted,
            output_id,
            output_name,
        })
    }
}

pub fn start_audio_monitor(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last_vol: f32 = -1.0;
        let mut last_muted: Option<bool> = None;
        let mut last_output_id = String::new();

        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(info) = get_quick_volume_info() {
                let vol_changed = (info.volume - last_vol).abs() > 0.005;
                let mute_changed = last_muted != Some(info.is_muted);
                let dev_changed = info.output_id != last_output_id;

                if vol_changed || mute_changed || dev_changed {
                    last_vol = info.volume;
                    last_muted = Some(info.is_muted);
                    last_output_id = info.output_id.clone();
                    let _ = app_handle.emit("audio_status_changed", &info);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_status_and_devices() {
        let status = get_audio_status().expect("get audio status");
        println!("Master Volume: {:.0}%", status.master_volume * 100.0);
        println!("Muted: {}", status.is_muted);
        println!("Current Output: {:?}", status.current_output_name);
        println!("Outputs ({}):", status.output_devices.len());
        for dev in &status.output_devices {
            println!("  - [{}] {} ({})", if dev.is_default { "DEFAULT" } else { " " }, dev.name, dev.id);
        }
        println!("Current Input: {:?}", status.current_input_name);
        println!("Inputs ({}):", status.input_devices.len());
        for dev in &status.input_devices {
            println!("  - [{}] {} ({})", if dev.is_default { "DEFAULT" } else { " " }, dev.name, dev.id);
        }
    }
}
