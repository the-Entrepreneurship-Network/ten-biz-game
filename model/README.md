# Track B — model work (personal laptop + Colab)

Independent of `app/`. The tutor in `app/` runs on Cloudflare Workers AI, so
nothing here blocks the product shipping.

- Training / experiments: Colab (free T4) or Kaggle — browser, either laptop.
- Local serving: Ollama or llama.cpp (any machine) / vLLM (NVIDIA only).
- Weights never go in Git. Push them to Hugging Face; Git chokes on GGUF.
