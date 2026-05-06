# TechPower — Project Layout

```
techpower/
├── app.py                  ← Flask backend (this artifact)
├── wpilog_parser.py        ← Your existing parser (from the prompt)
├── config.json             ← Your config (from the prompt)
├── requirements.txt
├── templates/
│   └── index.html          ← Your existing HTML (from the prompt)
└── static/
    └── js/
        └── techpower.js    ← Frontend (this artifact)
```

## Setup

```bash
pip install flask
python app.py          # → http://localhost:5000
```

Or with `flask`:
```bash
export FLASK_APP=app.py
flask run
```

## requirements.txt
```
flask>=3.0
```

## Key API endpoints

| Route | Method | Description |
|---|---|---|
| `/` | GET | Serves the dashboard |
| `/api/upload` | POST | Upload `.wpilog` files (multipart `logs` field) |
| `/api/session/<id>` | GET | Load an example session by ID (e.g. `Q17`) |

## Adding example logs

Drop `.wpilog` files at the paths listed in `config.json`:
```
assets/example-logs/Q17/FRC_20260407_183251_NYN2_Q17.wpilog
assets/example-logs/E3/FRC_20260408_183214_NYN2_E3.wpilog
```

## Notes on motor data

- **PDP channel current** is read from `/Robot/SystemStats/PowerDistribution/ChannelCurrent`
  and expected to be a `double[]` (one value per channel) per timestamp.

## TODO
- Video player
- Remove stator
- View subsystem (hoot -> wpilog)
- Better Timeline = Advantagescope Timeline