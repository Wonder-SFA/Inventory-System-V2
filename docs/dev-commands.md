# Developer Guide: Running & Managing the App

This guide explains every terminal command you need, what each one does, and how to use it.

> **Tip:** To stop any running command in the Terminal (like the app or the tunnel), click inside that Terminal window and press **`Ctrl + C`**.

---

## 1. Starting the App (Every Time)

### `pnpm dev`

- **What it's for:** Starts both the **Website** (what you see in the browser) and the **API** (the backend that talks to the database).
- **How to use it:**
  1. Open your **Terminal** in the project folder.
  2. Type `pnpm dev` and press **Enter**.
  3. Wait a few seconds until you see `Ready` in the output.
  4. Open your browser and go to **http://localhost:3000**.
- **Good to know:**
  - Leave this Terminal window open while using the app. Closing it (or pressing `Ctrl + C`) stops the app.
  - http://localhost:3001 is the API server—visiting it directly shows a `404` page, which is normal. If you want to view the API documentation, go to **http://localhost:3001/docs**.

---

## 2. Logging In

Once the website opens, use this default admin account:

- **Email:** `admin@inventory.local`
- **Password:** `password1234`

---

## 3. Accessing the App Remotely (Phone / Mobile Data)

### `cloudflared tunnel --url http://localhost:3000`

- **What it's for:** Creates a temporary, free public web link (`https://...trycloudflare.com`) that forwards to your local app, so you can open it from your phone or another laptop even on mobile data.
- **How to use it:**
  1. Make sure `pnpm dev` is already running in your first Terminal window.
  2. Open a **second** Terminal window.
  3. Type `cloudflared tunnel --url http://localhost:3000` and press **Enter**.
  4. Look for the link ending in `.trycloudflare.com` in the output, copy it, and open it in your browser.
  5. When you're done, press **`Ctrl + C`** in this Terminal window to close the public link.
- **If you see an "Invalid origin" error when logging in:**
  Each time you start a new tunnel, you get a new `.trycloudflare.com` link. Copy that link and ask Antigravity to add it to `trustedOrigins` in `apps/api/src/modules/iam/domain/auth.ts`.

---

## 4. One-Time Setup (Only on a Brand-New Computer)

You only need to run these once if you're setting up the project on a new Mac.

### `cp .env.example .env`
- **What it's for:** Creates your local `.env` settings file (which holds things like your database connection) by copying the template file.
- **How to use it:** Run it once in the project folder before starting the app for the first time.

### `pg_isready`
- **What it's for:** Checks whether PostgreSQL (the database) is running on your Mac.
- **How to use it:** Run it and look for `accepting connections` in the output.

### `createuser -s postgres` and `createdb -U postgres inventory_v2`
- **What it's for:** Creates the `postgres` database user and the `inventory_v2` database that the app expects.
- **How to use it:** Run both commands one after the other:
  ```bash
  createuser -s postgres
  createdb -U postgres inventory_v2
  ```

### `pnpm --filter @iv2/api exec tsx --env-file=../../.env src/scripts/seedDevUser.ts`
- **What it's for:** Creates the default admin login account (`admin@inventory.local` / `password1234`) in your database.
- **How to use it:** Run it once after creating the database. If the user already exists, it will simply tell you `Dev user already exists`.
