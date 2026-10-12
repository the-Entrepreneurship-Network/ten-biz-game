# Setup guide — personal laptop

You are setting up two independent things on one machine:

| Track | What it is | Needs a GPU? |
|---|---|---|
| **A — the app** | A kids' business-learning game. Deploys to Cloudflare's free tier. | No |
| **B — the model** | Local AI experiments (Ollama / llama.cpp / vLLM). | Helps, not required |

They do not depend on each other. Finish A first — it is short and it ships
something real. B can wait.

Everything here costs **₹0**. If any step asks for a card, stop and report back.

---

## Track A — the app

### A1. Check what is already installed

```bash
node -v && npm -v && git --version
```

Need Node **v18 or higher**. If all three print versions, skip to A3.

### A2. Install whatever is missing

| OS | Command |
|---|---|
| Ubuntu / Debian | `sudo apt update && sudo apt install -y nodejs npm git` |
| macOS | `brew install node git` |
| Windows | Install from https://nodejs.org (LTS) and https://git-scm.com |

If Ubuntu gives you Node 16 or older, use nvm instead:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL && nvm install --lts
```

Re-run A1 to confirm.

### A3. Unpack the project

You were sent `ten-biz-game.tar.gz`.

```bash
mkdir -p ~/projects && cd ~/projects
tar -xzf ~/Downloads/ten-biz-game.tar.gz
cd ten-biz-game
```

### A4. Run the tests — no account needed yet

```bash
cd app && npm test
```

Expect `# pass 4`, `# fail 0`. If this fails, stop and report it; nothing
below will work.

### A5. Cloudflare account

Sign up free at https://dash.cloudflare.com/sign-up — email and password
only. **Do not add a payment method.** We stay inside the free tier.

### A6. Log wrangler in

```bash
npm install          # installs wrangler locally, a minute or two
npx wrangler login   # opens a browser, click Allow
```

### A7. Create the database

```bash
npx wrangler d1 create ten-biz-game
```

It prints a block ending in `database_id = "xxxxxxxx-...."`.
**Open `app/wrangler.toml` and replace `PASTE_AFTER_d1_create` with that id.**
Keep the quotes.

### A8. Create the tables

```bash
npm run db:init
```

### A9. Deploy

```bash
npm run deploy
```

It prints a URL like `https://ten-biz-game.<something>.workers.dev`.
**Send that URL back.**

### A10. Check it actually works

Open the URL. You should see "Business Playground", a Points counter, and a
tutor box. Then:

1. Click **Finish a lesson** — points go 0 → 10, level stays 1.
2. Type "What is profit?" in the tutor box and click **Ask**.

If the tutor errors, run `npx wrangler ai models` and send the output — the
model name in `app/src/index.js` may need changing. Everything else working
with only the tutor broken is fine and expected to be a one-line fix.

---

## Track B — the model (later, no rush)

### B1. What GPU is in this machine?

```bash
# Linux
lspci | grep -i -E 'vga|3d|display'
nvidia-smi 2>/dev/null || echo "no NVIDIA driver"

# macOS
system_profiler SPHardwareDataType | grep -i chip

# Windows PowerShell
Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM
```

**Send the output.** It decides the next step:

| Result | Use |
|---|---|
| NVIDIA with 8 GB+ VRAM | vLLM (fastest) |
| NVIDIA with less, AMD, Intel, Apple, or none | **Ollama** — works everywhere |

### B2. Default path — Ollama

Unless told otherwise, do this; it works on any hardware.

```bash
curl -fsSL https://ollama.com/install.sh | sh     # macOS/Linux
# Windows: download from https://ollama.com/download
ollama run qwen2.5:3b
```

Type a question to confirm it answers, then `/bye`. That is Track B working.

Nothing else is needed yet. **Do not install vLLM or CUDA until asked** —
on the wrong hardware it is hours of pain for no gain.

---

## Rules for keeping both laptops in sync

1. **One Git repo.** Push to a branch, never straight to `main`.
   ```bash
   git checkout -b setup/personal-laptop
   git add -A && git commit -m "..." && git push -u origin setup/personal-laptop
   ```
2. **Model weights never go in Git.** No `.gguf`, no `.safetensors` — Git
   chokes on them. They are already in `.gitignore`. Use Hugging Face.
3. **No database files in Git either.** The database lives in Cloudflare and
   both machines talk to that same one. Nothing to copy.
4. **Never commit a secret.** No API keys, no `.dev.vars`, no tokens.
   If one is committed by mistake, say so immediately — it must be rotated,
   not just deleted.

## What to report back

- Output of A1 and B1
- The deployed URL from A9
- Whether A10's two checks passed
- Any error, pasted in full — the whole message, not a summary
