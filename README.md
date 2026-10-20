# TechPower

FRC Team 334's post-match power review for FRC robots. Load a match's robot log and CANivore hoot logs to see
battery sag, brownouts, whole-robot and per-motor current, motor temperature, and where the
energy went.

TechPower is a static web app: logs are read and analyzed in the browser, on your computer, and
never uploaded. It works offline once the page has loaded.

## Running it

**Online:** GitHub Pages deploys `web/` on every push to `main`
(`.github/workflows/pages.yml`). One-time setup: repo **Settings → Pages → Source: GitHub Actions**.
The site is then at `https://team334.github.io/TechPower/`.

**Locally:** serve the `web/` folder with any static file server, then open http://localhost:8000:

```bash
py -m http.server 8000 -d web     # Windows (or ./run.sh on macOS / Linux)
```

Opening `web/index.html` directly as a file doesn't work; browsers block the analysis worker there.

## Layout

| Path | What |
|---|---|
| `web/index.html` | Page and styles |
| `web/js/techpower.js` | Dashboard UI |
| `web/js/analysis.js` | WPILog parser and power analysis (shared by the browser and Node) |
| `web/js/worker.js` | Runs the analysis off the main thread |
| `web/config.json` | Log keys, motors, thresholds, field calibration |
| `web/examples/*.json` | Pre-analyzed example matches |
| `tools/build-examples.mjs` | Rebuilds the example JSON |

## Example matches

The example logs in `assets/example-logs/` are stored with Git LFS, which GitHub Pages can't
serve, so the site ships their analysis results instead. After changing the analysis or
`config.json`, rebuild them (needs Node 20+ and `git lfs pull`):

```bash
node tools/build-examples.mjs
```

## Logs

Add up to three `.wpilog` files from one match:

| File | Pattern | Needed for |
|---|---|---|
| Robot log | `FRC_*.wpilog` | Required: battery voltage, PDH current, brownouts, match phases |
| Swerve CANivore | `*_CC<serial>_<date>.hoot.wpilog` | Swerve motor current / voltage / temperature |
| Subsystems CANivore | `*_01<serial>_<date>.hoot.wpilog` | Subsystem motor data |

Hoot files must be converted to `.wpilog` first (Phoenix Tuner / owlet). The two-character
prefix after the match name picks the bus (`prefix_map` in `web/config.json`).

Hoot logs run on the CANivore's clock, so TechPower shifts them onto the robot log's clock by
matching the first robot-enable edge in each. If the robot never enabled, a warning is shown.

## Using the dashboard

- Drag along the timeline bar to scrub. Click any chart to jump there.
- Drag across a chart to zoom into that span. The − / + buttons (or keys) zoom around the cursor;
  Ctrl + scroll and pinch also zoom. Double-click or Esc shows the whole match.
- Space plays, arrow keys step 1 s (Shift: 5 s).
- Click motors in **Values at cursor** to compare up to four in the motor charts.
- Click the brownout count to jump to the next brownout.
- The **Field** panel shows where the robot was at the cursor (`Pose2d`, blue origin, same view as
  AdvantageScope), with a 5 s trail shaded by current draw, the planned auto path, and red rings
  where brownouts happened. Select a ring to jump to it.
- **Brownouts** lists every brownout with its depth, the robot's draw and the three motors pulling
  the most supply current; select one to jump to it.
- Example matches can be linked directly: `#example=Q17&tab=energy`.

## Metrics

- **Battery resistance / resting voltage** — fitted from voltage sag vs. PDH current (with the PDH's
  CAN reporting lag removed). Includes main wiring, so compare across matches to spot weak batteries.
- **Charge used (Ah)** and **energy (Wh)** — whole robot, by match phase, and per motor (net of regen).
- **Time under 8 V** — how long the robot spent sagging toward brownout.
- **RMS supply current / time over breaker** per motor — what heats wiring and trips 40 A breakers;
  a sign supply current limits are too high.

## Configuration

`web/config.json` maps log keys and motors:

- `log_sources.wpilog.keys` — robot-log entry names, including `pose` (`struct:Pose2d`),
  `chassis_speeds` and `auto_trajectory` (`struct:Pose2d[]`). Battery current comes from the PDH
  `TotalCurrent` (the SystemStats `BatteryCurrent` entry is only the roboRIO's own draw).
- `log_sources.hoot.signal_keys` — Phoenix 6 TalonFX signal names.
- `thresholds` — `sag_voltage` for the "time under" readout, `breaker_amps` for the per-motor
  "over breaker" time (match your PDH breakers).
- `field` — field image and its pixel calibration (copied from AdvantageScope's field config,
  scaled to the shipped image), and robot bumper size for drawing.
- `motors` — one entry per TalonFX: CANivore bus, CAN ID, PDH channel, subsystem.

## TODO
- Video player
- View subsystem (hoot -> wpilog)
- AdvantageScope-style timeline

## Credits

The 2026 field image comes from [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope)
by FRC 6328; see `web/img/FIELD_LICENSE.txt`.
