import { exec } from 'child_process'
import { promisify } from 'util'
import type { GPUInfo } from '../index'

const execPromise = promisify(exec)

interface SPDisplayItem {
  _name?: string
  spdisplays_mtlgpufamilysupport?: string
  sppci_cores?: string
  sppci_model?: string
  spdisplays_vendor?: string
  [key: string]: unknown
}

interface SPDisplaysOutput {
  SPDisplaysDataType?: SPDisplayItem[]
}

/**
 * Gathers information about GPUs on macOS via system_profiler
 */
export async function getGpuInfo_mac(): Promise<GPUInfo[]> {
  try {
    const { stdout } = await execPromise(
      'system_profiler SPDisplaysDataType -json'
    )
    const parsed: SPDisplaysOutput = JSON.parse(stdout)
    const displays = parsed.SPDisplaysDataType || []

    return displays.map((disp, idx) => {
      const name = disp.sppci_model || disp._name || 'Apple GPU'
      const cores = disp.sppci_cores ? ` (${disp.sppci_cores} cores)` : ''
      const metalFamily = (disp.spdisplays_mtlgpufamilysupport || '')
        .replace('spdisplays_', '')
        .replace('metal', 'Metal ')

      const vendorRaw = disp.spdisplays_vendor || ''
      const isApple = vendorRaw.includes('Apple') || name.startsWith('Apple')
      const isAMD =
        vendorRaw.includes('AMD') ||
        vendorRaw.includes('Advanced Micro') ||
        name.includes('Radeon')
      const isIntel = vendorRaw.includes('Intel')

      let vendorString = 'Apple'
      let vendorId = '106b'
      if (isAMD) {
        vendorString = 'AMD'
        vendorId = '1002'
      } else if (isIntel) {
        vendorString = 'Intel'
        vendorId = '8086'
      } else if (!isApple) {
        vendorString = vendorRaw.replace('sppci_vendor_', '') || 'Apple'
      }

      return {
        deviceId: `0x${(idx + 1).toString(16).padStart(4, '0')}`,
        vendorId: `0x${vendorId}`,
        deviceString: `${name}${cores}`,
        vendorString,
        driverVersion: metalFamily || 'Metal'
      }
    })
  } catch {
    return [
      {
        deviceId: '0x0001',
        vendorId: '0x106b',
        deviceString: 'Apple Silicon GPU',
        vendorString: 'Apple',
        driverVersion: 'Metal'
      }
    ]
  }
}
