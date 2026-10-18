# macOS: Game Porting Toolkit 3, DLSS on MetalFX and Hellblade II

This fork adds Apple Silicon support work to Heroic. The goal was to run _Senua's Saga: Hellblade II_ (Epic, Unreal Engine 5.3) with the best graphics and frame rate possible on a Mac Studio:

- M4 Max with a 32-core GPU and 36 GB of memory
- macOS 27.2
- a 49-inch 5120x1440, 144 Hz monitor

**Where it ended up:** the game runs at the monitor's native 5120x1440 with every graphics setting at High, which is the game's real maximum. It uses DLSS Ultra Performance on Apple's MetalFX upscaler and DLSS Frame Generation on MetalFX frame interpolation. That shows about 45 fps in gameplay. Before this work the game showed 17–27 fps with a reduced render resolution and lighting features turned off. A fresh install now starts in this configuration automatically.

This document records everything that was built, measured and learned, including what didn't work.

## Where everything is

| Location                                                                                  | What it holds                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `main` in this fork                                                                       | All finished macOS features (commits listed below)                                                     |
| `wip/gptk4-import` in this fork                                                           | Unfinished importer for Apple's Game Porting Toolkit 4 disk image                                      |
| `feat/mac-dlss-via-metalfx` in this fork                                                  | The DLSS via MetalFX feature on its own, rebased on upstream                                           |
| [Heroic PR #5984](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/pull/5984) | Upstream contribution of that branch (draft)                                                           |
| `feat/mac-apple-silicon-optimizer` in this fork                                           | The earlier "Mac optimizer", replaced by this work                                                     |
| [hellblade2-mac-lab](https://github.com/Shaurya-Srivastav/hellblade2-mac-lab) (private)   | Experiment tooling: Windows probes, the injected hook, benchmarks, measurement scripts and raw results |

Things that stay on the Mac, on purpose:

- **Apple's Game Porting Toolkit 4 disk image** (`Game_Porting_Toolkit_*.dmg`). It's Apple's licensed download and is excluded in `.git/info/exclude`.
- **Game files and saves.** Hellblade II's settings files from before the cleanup are backed up in `~/Games/Heroic/Backups/hellblade2-before-cleanup-20261016-004933`.
- **Test runners and a test prefix** in `~/Library/Application Support/heroic/tools/game-porting-toolkit`, about 2.7 GB in total. None of them are needed anymore:
  - `Game-Porting-Toolkit-3.0-3-driver616`, a driver-version experiment;
  - `Game-Porting-Toolkit-D3DMetal-4.0b3`, plus `.importing/W11-D3DM4`, the Game Porting Toolkit 4 attempts;
  - the `Hellblade II (Wine 11 test)` prefix.
- **`Game-Porting-Toolkit-3.0-3-fg`**, the runner Hellblade II currently uses. It's a copy of 3.0-3 with the frame generation patch applied. Heroic now applies that patch itself, so the stock 3.0-3 runner works the same.

## Commits

### `f4024aab`: replace the Mac optimizer with D3DMetal 3 DLSS via MetalFX

The earlier optimizer (`mac_optimizer.ts`, about 1,150 lines) made the game look worse while chasing frame rate:

- `Engine.ini` overrides turned off Lumen, virtual shadow maps and fog, and set a 55–60% render scale;
- it made binary edits to the game's saves, forcing the Low preset and FSR3;
- it added fake AMD driver registry keys and GPU-spoofing `dxvk.conf` files.

Its parts also contradicted each other. `ConsoleVariables.ini` turned the fog and Lumen back on, and the log claimed XeSS while the save got FSR3. All of it was removed and replaced with `src/backend/utils/macos/`:

- **D3DMetal detection.** Reads each runner's `D3DMetal.framework` version and ranks runners so Game Porting Toolkit 3 (D3DMetal 3.0) is preferred and offered for download.
- **DLSS via MetalFX** (per-game setting). Games only find DLSS when four things are in place:
  - the runner's `nvngx.dll` is replaced with `nvngx-on-metalfx.dll`;
  - `nvngx.dll` and `nvapi64.dll` are copied into the prefix's `system32`;
  - `HKLM\Software\NVIDIA Corporation\Global\NGXCore\FullPath` is set;
  - the game runs with `D3DM_ENABLE_METALFX=1`.

  With that variable set, D3DMetal reports an NVIDIA GPU (vendor `0x10DE`), and Hellblade II offers DLSS and NVIDIA Reflex. DXMT builds use `DXMT_ENABLE_NVEXT=1` instead.

- **Hardware ray tracing toggle** (`D3DM_SUPPORT_DXR`). Off by default, and only useful on M3 or newer. Hellblade II doesn't use it: it uses software Lumen.
- **Retina mode setting**, and a small reversible `Engine.ini` block for Hellblade II's lens effects (letterbox, lens blur, film grain).
- **Verified executable patches**, each behind its own setting.
- **Display logging.** Logs the attached displays and warns when only a 60 Hz virtual display (Screen Sharing) is connected.
- **Performance report.** When the game exits, Heroic logs the frame rate and GPU time macOS measured, using `metalperftrace`. It initially never appeared because it asked for statistics up to a second in the future, which `metalperftrace` rejects.

The commit also fixes these bugs:

- Wine launch errors now resolve instead of hanging forever.
- The GOG offline check tested the function `isOnline` instead of calling it.
- A third-party splice used a missing index.
- Homebrew and custom Wine builds weren't found on macOS.
- Logs named the GPU "Apple Apple M4 Max".
- `existsSync(undefined)` ran when no system-wide Game Porting Toolkit is installed.
- macOS version codenames were wrong.

### `887b06bd`: start supported games at their highest graphics settings

On its first launch Hellblade II benchmarks the GPU. Under D3DMetal the benchmark's GPU timestamp query isn't supported (D3DMetal logs `EndQuery - Type = 2`), so the game records a placeholder score and picks **Low**.

The new per-game setting "Start at the highest graphics settings" is on by default on Mac. After the game's first launch, it does this once:

- raises every quality setting in the save to the highest preset the game defines, read from the game's own `BaseGraphics` data. That's High: the game's "Ultra" option has no settings behind it;
- turns off dynamic resolution;
- selects DLSS when DLSS runs on MetalFX.

Changes made in the game afterwards are kept. The settings also survive the game re-running its benchmark on a new day, which happens because Wine reports the current date as the GPU driver date.

This needed a reader and writer for Unreal's save format (GVAS) in `gvas.ts`. It round-trips unmodified saves byte for byte.

### `b576f8c7`: offer DLSS Frame Generation on Game Porting Toolkit runners

D3DMetal 3 already implements DLSS Frame Generation with MetalFX frame interpolation, but the game never offered it. A probe that loads the game's own copy of NVIDIA Streamline found the reason:

- Streamline only enables frame generation when Windows reports hardware-accelerated GPU scheduling.
- It reads that through `D3DKMTEnumAdapters2` and `D3DKMTQueryAdapterInfo` (`KMTQAITYPE_WDDM_2_7_CAPS`).
- The Wine 7.7 in Game Porting Toolkit 3 exports neither.

Every other check passed, including the OS, driver and GPU checks. An earlier theory, that the reported driver 512.33 was below Streamline's minimum of 522.25, was tested by patching D3DMetal to report 616.56. That made no difference.

On macOS 26 and newer, Heroic now adds both functions to the runner's 64-bit `gdi32.dll`:

- The functions are small hand-assembled x86-64 routines generated in `d3dkmt.ts`. They go into a new PE section with a rebuilt export directory and a fixed checksum. The original file is kept as `gdi32.dll.heroic-stock`.
- They report one adapter, with LUID `0:0xd3d1` and hardware scheduling enabled. Streamline requires that the adapter IDs from these functions, DXGI and NVAPI all match, and they do.
- The functions must not call back into DXGI. D3DMetal's `dxgi.dll` calls `D3DKMTEnumAdapters2` from its own callback thread, and an early prototype that called `CreateDXGIFactory1` from there crashed.
- Runners whose Wine already has these functions, like CrossOver's, are left alone, and so is a `gdi32.dll` that has only one of them.

### `1fb42397`: Hellblade II defaults (native resolution, DLSS mode, frame generation)

**The half-resolution bug.** Every DLSS mode rendered into a 2560x720 image and stretched it to 5120x1440, which is why the game looked blurry. Hellblade II's own code caused it:

- On the first launch under Wine, it saves a render target (`TargetRes`) of 1843x1008 for a 5120x1440 window.
- Its resolution logic fits that target to the window's 32:9 aspect ratio, which gives a 518-pixel height.
- That's below its 720-pixel minimum, so it clamps to 720/1440.
- It then sets `r.SecondaryScreenPercentage.GameViewport` to 50 with console priority, which overrides any `.ini` setting.

Disassembling the game confirmed this, and setting the variable live (with `cvarpeek`) switched the output to full size. Ruled out along the way: Retina mode, Wine's DPI, Wine's display modes (Windows code sees 5120x1440), D3DMetal's DLSS sizing callback, `sg.ResolutionQuality`, and dynamic resolution.

**What Heroic now does once, along with the highest settings:**

- **Render target.** Sets `TargetRes` to the window size Unreal saved in `GameUserSettings.ini`.
- **DLSS mode.** Picks the sharpest mode that renders at most as many pixels as 720p:

  | Window    | DLSS mode         |
  | --------- | ----------------- |
  | 1920x1080 | Quality           |
  | 1920x1200 | Balanced          |
  | 2560x1440 | Performance       |
  | 3840x2160 | Ultra Performance |
  | 5120x1440 | Ultra Performance |

- **Frame generation.** Turns on DLSS Frame Generation when the runner reports hardware-accelerated GPU scheduling.

The save values match what the game writes when the same options are picked in its menu: `QualityModeId` `UltraPerformance` and `FrameGenerationId` `On` in the `DLSS` entry of `UpscalerSettings`. Applying the code to a copy of an earlier save produced a DLSS entry byte-identical to the one the game wrote itself.

### Upstream contribution

[PR #5984](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/pull/5984) offers the DLSS via MetalFX setting to Heroic on its own, without the Hellblade-specific parts. It covers runner and prefix setup, a CrossOver path, a DXMT path, log messages and tests. Frame generation would be a separate follow-up PR. The PR follows the repository's template, discloses that an AI agent (Cursor) wrote the code, and is a draft until it's been tested on a clean install.

## Measurements

All numbers were measured on the Mac Studio described above with `metalperftrace` and the Metal performance HUD. They come from gameplay at 5120x1440 output with frame generation on, unless noted. "Real" counts rendered frames; "shown" includes the generated ones.

| DLSS mode         | Render resolution | Shown fps | Real fps |
| ----------------- | ----------------- | --------- | -------- |
| Quality           | 3416x961          | 26        | 13       |
| Balanced          | 2970x836          | 31        | 15.6     |
| Performance       | 2560x720          | 30        | 15.0     |
| Ultra Performance | 1705x480          | 37        | 18.4     |

Performance landing below Balanced is scene noise: that run's baseline was slower too. In normal play at Ultra Performance the game showed about 45 fps.

Turning single features off, at DLSS Quality:

- **Lumen global illumination off:** 26 → 34 shown fps. It removes the bounced light that defines the game's look, so it stays on.
- **Volumetric fog off:** about 27 → 29 shown fps.
- **Lumen reflections off, or a lower virtual shadow map resolution:** no measurable change.

Other findings:

- **Most of the frame cost doesn't scale with resolution.** Cutting rendered pixels by 75% (Quality to Ultra Performance) saved 21 of the 78 ms of GPU time per real frame. Comparing with an earlier half-resolution run suggests about 35–40 ms per frame goes to work that doesn't shrink with resolution: lighting, shadows, geometry and fog. That figure is an estimate from two runs in different scenes.
- **Memory isn't the limit.** The game uses about 9.6 GB of GPU memory. Speed is limited by shader throughput and memory bandwidth, plus Direct3D-to-Metal translation of about 1,200 draws, 970 `ExecuteIndirect` calls and 500 compute dispatches per frame.
- **Frame interpolation costs 5.4 ms of GPU time per generated frame** at this resolution (measured with `mfxbench`). It also delays the picture by one real-frame interval, which was 77 ms at Quality.
- **Menus are cheap.** Menus run at about 200–340 fps (3 ms of GPU time per frame). The first test run, at 1920x1080 over Screen Sharing, measured 119 fps on the title screen with High settings and DLSS Quality.
- **D3DMetal 3's tuning switches are already at their best defaults.** Async commit is on by default, and the multithreaded interface switch only applies to Direct3D 11.
- **MetalFX's Neural Engine path fails under Rosetta.** The game log shows repeated "Bad argument" errors compiling Neural Engine models, and MetalFX falls back to the GPU. The measured difference between the arm64 and x86-64 upscaler cost is about 0.5 ms.

## Game Porting Toolkit 4 (unfinished)

Apple's Game Porting Toolkit 4.0 beta 3 contains D3DMetal 4. Compared with D3DMetal 3 it adds:

- a Metal 4 backend (`D3DM_MTL4`) and a frame cap (`D3DM_MAX_FPS`);
- a reported driver version of 616.56;
- full NVIDIA Reflex in its `nvapi64.dll`;
- a profile matching Hellblade II's executable.

Getting it to run failed in two ways:

- **On the Wine 7.7 in Gcenx's toolkit,** its `dxgi.dll` fails to initialize. It needs Wine's newer `__wine_init_unix_call` interface.
- **On Wine Staging 11.18,** the game crashes at startup with a zero `%gs` segment base. D3DMetal 4 relies on CrossOver's thread-register handling.

It needs the Wine in CrossOver 25/26. The importer on `wip/gptk4-import` builds a runner from Apple's disk image the way Apple's Read Me describes. It works, but the result can't launch games until it's paired with CrossOver's Wine. Published tests put D3DMetal 4's gain in Unreal Engine 5 games at about 6–10%.

## Incidents during the work

- **The development build took over `heroic://` links.** Running it made macOS send `heroic://` links to it. The handler was set back to the installed Heroic app both times.
- **A GPU capture replay restarted WindowServer.** Replaying a 16 GB GPU frame capture with `gpudebug` exhausted memory, and macOS restarted WindowServer. That logged the session out and closed the game. Large captures aren't replayed anymore.
- **A live memory write crashed the game.** A measurement script wrote console variables straight into the game's memory, and turning volumetric fog back on that way crashed it, because the engine never rebuilt the fog's GPU data. Nothing writes to the game's memory while it's being played anymore.
- **A backend edit ended a play session.** Editing backend files restarts the development build, which ended a session. The game autosaves at checkpoints.

## Testing

- `src/backend/utils/macos` has 81 tests and all pass.
- `pnpm codecheck`, `pnpm lint`, `pnpm prettier` and `pnpm i18n` pass.
- The full test suite also has 4 failures, in `nonesteamgame.test.ts` and `wine/manager/__tests__/architecture.test.ts`. They fail the same way on unmodified upstream on this Mac.
