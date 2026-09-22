# WARDOGS Tracker Bot — Setup Guide

This guide walks you through everything needed to get your own copy of the bot running, from a blank folder to a working Discord channel that tracks WARDOGS profit/loss for your friends. No coding experience is required — just follow each step in order.

You're filling in one file as you go: **`.env`** (already included in this folder, blank and ready to go — if it's missing, copy `.env.example` and rename the copy to `.env`). Open it in any plain text editor and keep it open as you work through this guide — each step tells you exactly which line to fill in.

---

## What you'll need before you start

- The bot's files (already provided to you).
- [Node.js](https://nodejs.org/) installed on the computer that will run the bot (download the "LTS" version, run the installer, keep the defaults).
- A Discord account, and a Discord server you have admin access to.
- A Steam account you don't mind using as a dedicated "bot" account (see Step 1 — you'll be creating a brand new one, not using your personal account).
- A computer/server that can stay on and connected to the internet while the bot runs (this can be your own PC, but it needs to stay running — see "Keeping the bot running" at the end).

---

## Part 1 — The dummy Steam account

This bot needs its own Steam account to add your friends and read their in-game activity. **Do not use your personal Steam account for this.**

### Step 1.1 — Create the account

1. Go to [store.steampowered.com](https://store.steampowered.com) and click **Login**, then **Create a new account**.
2. You can name this account anything you like — it doesn't need to look official or match your product name. Pick any username/password.
3. Finish the signup (you'll need an email address for it — a free email inbox is fine).
4. You do **not** need to buy anything or add any money to this account. A completely free account works.

### Step 1.2 — Disable Steam Guard on the dummy account

The bot logs in automatically without a human typing a code, so Steam Guard (the login code prompt) needs to be turned off for this account specifically.

1. Install the Steam desktop client if you don't already have it, and log into it using the new dummy account.
2. In the Steam client, go to **Steam** (top-left menu) → **Settings** → **Account** → **Manage Steam Guard Account Security**.
3. Choose the option to remove/disable Steam Guard for this account.
4. Steam may require you to confirm this by email, and there can be a short waiting period (Steam sometimes enforces a delay of a week or two before a removal request fully takes effect) — plan for that possible delay before you need the bot fully running. Check back on this account in the meantime.
5. Once Steam Guard is off, logging into this account should no longer prompt for a code.

### Step 1.3 — Get the account's Friend Code

Your Discord users will need this to add the dummy account as a friend on Steam.

1. While logged into the dummy account in the Steam client, click the **Friends & Chat** icon (bottom-right).
2. Click **Add a Friend**.
3. Your account's personal **Friend Code** is shown in that panel — copy it.
4. Open your `.env` file and paste it in:
   ```
   STEAM_FRIEND_CODE=paste_it_here
   ```

### Step 1.4 — Fill in the account name and password

In `.env`, fill in:
```
STEAM_ACCOUNT_NAME=the_username_you_created
STEAM_PASSWORD=the_password_you_created
```

### Step 1.5 — Get a Steam Web API key

This key lets the bot look up Steam profile links (like `steamcommunity.com/id/somename`) and convert them to the ID numbers it actually needs.

1. Go to [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
2. **Important: you do not need to be logged into the dummy account for this.** Log in with any Steam account you have — your own personal one is fine. The key isn't tied to the dummy account at all.
3. It will ask for a "Domain Name." This doesn't need to be a real website you own — Steam doesn't verify it. You can enter something like `localhost` or any placeholder text.
4. Agree to the terms and submit. You'll be given a key — a long string of letters and numbers.
5. Paste it into `.env`:
   ```
   STEAM_API_KEY=paste_it_here
   ```

Part 1 is done — your `.env` should now have `STEAM_ACCOUNT_NAME`, `STEAM_PASSWORD`, `STEAM_API_KEY`, and `STEAM_FRIEND_CODE` all filled in.

---

## Part 2 — The Discord bot

### Step 2.1 — Create the Discord application and bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and log in with your normal Discord account.
2. Click **New Application**, give it a name (this name is what shows up as the bot's username in Discord — name it whatever you like).
3. On the **General Information** page, find **Application ID** and copy it. Paste it into `.env`:
   ```
   DISCORD_CLIENT_ID=paste_it_here
   ```
4. In the left sidebar, click **Bot**.
5. Click **Reset Token** (or **Copy** if a token is already shown) to get the bot's token. **Treat this like a password — anyone with it can control your bot.**
6. Paste it into `.env`:
   ```
   DISCORD_BOT_TOKEN=paste_it_here
   ```
7. No privileged intents need to be turned on for this bot (you can leave "Presence Intent," "Server Members Intent," and "Message Content Intent" switched off).

### Step 2.2 — Invite the bot to your server

1. Still in the Developer Portal, go to **OAuth2** → **URL Generator** in the left sidebar.
2. Under **Scopes**, check **`bot`** and **`applications.commands`**.
3. Under **Bot Permissions**, check at least: **Send Messages**, **Embed Links**, **Read Message History**, **Use Slash Commands**.
4. Copy the generated URL at the bottom, paste it into your browser, choose your server, and click **Authorize**.

### Step 2.3 — Get your Server (Guild) ID

1. In Discord, open **User Settings** (gear icon) → **Advanced**, and turn on **Developer Mode**.
2. Right-click your server's icon in the sidebar and click **Copy Server ID**.
3. Paste it into `.env`:
   ```
   DISCORD_GUILD_ID=paste_it_here
   ```

### Step 2.4 — Get your Channel ID

1. Decide which text channel the bot should post the tracker cards into (create a new channel for it if you'd like a clean, dedicated space).
2. Right-click that channel and click **Copy Channel ID**.
3. Paste it into `.env`:
   ```
   DISCORD_CHANNEL_ID=paste_it_here
   ```

Your `.env` file should now be completely filled in — all 8 values. Double check nothing is blank before continuing.

---

## Part 3 — Running the bot

1. Make sure [Node.js](https://nodejs.org/) is installed (open a terminal/command prompt and type `node -v` — if it prints a version number, you're set).
2. Open a terminal in the bot's folder (the one containing `bot.js`).
3. Run:
   ```
   npm install
   ```
   This downloads the bot's dependencies — only needs to be done once (or again if the bot's files are ever updated).
4. Start the bot by double-clicking **`run.bat`** (Windows), or running it from a terminal. Leave that window open — closing it stops the bot.
5. Watch the terminal window. You should see it log into Discord, then log into Steam. If Steam Guard wasn't fully removed yet (see Step 1.2), it will pause and ask you to type in a code from your email — this means you need to finish disabling Steam Guard before the bot can run unattended.

## Part 4 — First-time use

1. In your Discord server, in any channel, type `/track add` and follow the prompt to enter your Steam profile (a raw SteamID64, or a `steamcommunity.com/id/...` link both work).
2. The bot will reply telling you to add its dummy account as a friend on Steam using the Friend Code from Step 1.3.
3. Send that friend request from your own Steam account. The bot auto-accepts it within a few seconds.
4. Start playing WARDOGS — within moments of your rich presence updating, a card should appear in the channel you set as `DISCORD_CHANNEL_ID`.
5. Type `/track help` at any time in Discord for a full list of commands and what they do.

## Keeping the bot running

- The bot restarts itself automatically once an hour as a reliability measure — this is normal and expected, and `run.bat` handles relaunching it. Don't be alarmed if you see the terminal window clear and reconnect on its own.
- The computer running `run.bat` needs to stay on and connected to the internet for the bot to keep tracking. If you close the terminal window or shut down the computer, the bot stops until you start it again.
- All of the bot's data (who it's tracking, everyone's balances/history) is saved to `.json` files in the same folder — it's safe to stop and restart the bot at any time without losing anything.

## Troubleshooting

- **Bot won't log into Steam / keeps asking for a Steam Guard code** → Steam Guard hasn't finished being disabled on the dummy account yet. Revisit Step 1.2.
- **Slash commands don't show up in Discord** → make sure you invited the bot with both the `bot` and `applications.commands` scopes (Step 2.2), and that `DISCORD_GUILD_ID` is correct. It can take a minute or two after the bot first starts for commands to appear.
- **Bot logs in but never posts anything** → double-check `DISCORD_CHANNEL_ID` points to a channel the bot actually has permission to post in.
- **"Could not resolve that to a Steam account" when running `/track add`** → double check `STEAM_API_KEY` is filled in correctly in `.env`.
