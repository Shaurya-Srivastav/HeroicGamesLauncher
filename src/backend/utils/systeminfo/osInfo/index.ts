import process from 'process'

async function getOsInfo(): Promise<{ name: string; version?: string }> {
  switch (process.platform) {
    case 'win32': {
      const { osInfo_windows } = await import('./windows')
      return osInfo_windows()
    }
    case 'linux': {
      const { osInfo_linux } = await import('./linux')
      return osInfo_linux()
    }
    case 'darwin': {
      const release = process.getSystemVersion?.() || ''
      const major = parseInt(release.split('.')[0] || '0', 10)
      const codenames: Record<number, string> = {
        11: 'Big Sur',
        12: 'Monterey',
        13: 'Ventura',
        14: 'Sonoma',
        15: 'Sequoia',
        16: 'Tahoe',
        26: 'Sequoia'
      }
      const codename = codenames[major] ? ` ${codenames[major]}` : ''
      return { name: `macOS${codename}`, version: release }
    }
    default:
      return { name: '' }
  }
}

export { getOsInfo }
