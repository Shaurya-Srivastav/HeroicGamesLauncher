import ContextProvider from 'frontend/state/ContextProvider'
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsContext from '../SettingsContext'
import useSetting from 'frontend/hooks/useSetting'
import { ToggleSwitch } from 'frontend/components/UI'
import InfoIcon from 'frontend/components/UI/InfoIcon'

const MacHighestGraphics = () => {
  const { t } = useTranslation()
  const { platform } = useContext(ContextProvider)
  const { isMacNative } = useContext(SettingsContext)
  const isMac = platform === 'darwin'
  const [macHighestGraphics, setMacHighestGraphics] = useSetting(
    'macHighestGraphics',
    true
  )

  if (!isMac || isMacNative) {
    return <></>
  }

  return (
    <div className="toggleRow">
      <ToggleSwitch
        htmlId="macHighestGraphicsToggle"
        value={macHighestGraphics}
        handleChange={() => setMacHighestGraphics(!macHighestGraphics)}
        title={t(
          'setting.macHighestGraphics',
          'Start at the highest graphics settings'
        )}
      />

      <InfoIcon
        text={t(
          'help.macHighestGraphics',
          "Supported games (currently Senua's Saga: Hellblade II) benchmark the GPU on their first launch and pick low settings under D3DMetal. Heroic raises every graphics setting to the highest the game offers once, turns off dynamic resolution and, with DLSS via MetalFX on, selects DLSS Quality. Changes you make in the game afterwards are kept."
        )}
      />
    </div>
  )
}

export default MacHighestGraphics
