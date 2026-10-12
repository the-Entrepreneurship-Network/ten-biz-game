# TEN Business Playground

Gamified business learning for school students. Separate from the internship
portal — different repo, different hosting, no shared infrastructure.

    app/     the site, the API and the tutor   (Cloudflare, free tier)
    model/   training and local inference      (Colab / personal laptop)

Running cost: **₹0.** Workers, D1, Workers AI and Pages all sit inside free
allowances, and a `*.pages.dev` subdomain costs nothing.

## Set up (one time, browser — either laptop)

    npm install -g wrangler
    wrangler login

    cd app
    wrangler d1 create ten-biz-game      # paste the id into wrangler.toml
    npm run db:init                      # creates the tables
    npm run deploy                       # live on *.workers.dev

## Day to day

    npm test        # scoring rules, no network, no install
    npm run dev     # local preview
    npm run deploy

## What is deliberately missing

- **The game loop.** `event.kind` is free-form on purpose, so picking the
  mechanics later needs no migration.
- **Real authentication.** `sid` is an opaque cookie, not a login. It must
  become a real session before any teacher view, parent login, or personal
  detail beyond a first name.
