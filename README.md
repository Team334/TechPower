# TechPower

Post-match power review for FRC robots. Load a match's robot log and CANivore hoot logs to see
battery sag, brownouts, whole-robot and per-motor current, motor temperature, and where the
energy went.

## Setup

Requires Python 3.10+.

```bash
pip install -r requirements.txt
python app.py          # → http://localhost:5000
```

Example logs are stored with Git LFS. If an example fails to open with a "Git LFS pointer"
error, run `git lfs pull`.

## Logs

Upload up to three `.wpilog` files from one match:

| File | Pattern | Needed for |
|---|---|---|
| Robot log | `FRC_*.wpilog` | Required: battery voltage, PDH current, brownouts, match phases |
| Swerve CANivore | `*_CC<serial>_<date>.hoot.wpilog` | Swerve motor current / voltage / temperature |
| Subsystems CANivore | `*_01<serial>_<date>.hoot.wpilog` | Subsystem motor data |

Hoot files must be converted to `.wpilog` first (Phoenix Tuner / owlet). The two-character
prefix after the match name picks the bus (`prefix_map` in `config.json`).

Hoot logs run on the CANivore's clock, so TechPower shifts them onto the robot log's clock by
matching the first robot-enable edge in each. If the robot never enabled, a warning is shown.

## Using the dashboard

- Drag along the timeline bar to scrub. Click any chart to jump there.
- Drag across a chart to zoom into that span. The − / + buttons (or keys) zoom around the cursor;
  Ctrl + scroll and pinch also zoom. Double-click or Esc shows the whole match.
- Space plays, arrow keys step 1 s (Shift: 5 s).
- Click motors in **Values at cursor** to compare up to four in the motor charts.
- Click the brownout count to jump to the next brownout.
- **Brownouts** lists every brownout with its depth, the robot's draw and the three motors pulling
  the most supply current; select one to jump to it.
- Example matches can be linked directly: `/#example=Q17&tab=energy`.

## Metrics

- **Battery resistance / resting voltage** — fitted from voltage sag vs. PDH current (with the PDH's
  CAN reporting lag removed). Includes main wiring, so compare across matches to spot weak batteries.
- **Charge used (Ah)** and **energy (Wh)** — whole robot, by match phase, and per motor (net of regen).
- **Time under 8 V** — how long the robot spent sagging toward brownout.
- **RMS supply current / time over breaker** per motor — what heats wiring and trips 40 A breakers;
  a sign supply current limits are too high.

## Configuration

`config.json` maps log keys and motors:

- `log_sources.wpilog.keys` — robot-log entry names. Battery current comes from the PDH
  `TotalCurrent` (the SystemStats `BatteryCurrent` entry is only the roboRIO's own draw).
- `log_sources.hoot.signal_keys` — Phoenix 6 TalonFX signal names.
- `thresholds` — `sag_voltage` for the "time under" readout, `breaker_amps` for the per-motor
  "over breaker" time (match your PDH breakers).
- `motors` — one entry per TalonFX: CANivore bus, CAN ID, PDH channel, subsystem.

## API

| Route | Method | Description |
|---|---|---|
| `/` | GET | Dashboard |
| `/api/analyze` | POST | Analyze uploaded logs (multipart field `logs`, 1–3 files) |
| `/api/example/<id>` | GET | Analyze a bundled example session (e.g. `Q17`) |

Errors come back as `{"error": "..."}` with a 4xx/5xx status. Results are cached in memory,
so reopening a match is instant.

## TODO
- Video player
- View subsystem (hoot -> wpilog)
- AdvantageScope-style timeline
