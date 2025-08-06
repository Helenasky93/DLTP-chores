# ChoreBot (Slack)

A small Slack bot that **assigns chores fairly each week**, posts the assignments to a channel, and **DMs reminders** before each chore is due.

- **Fair rotation**: picks whoever has done a given chore the fewest times in recent weeks (ties broken randomly).
- **Weekly auto-post**: Sundays at 8:00 PM PT to your `#house-chores` channel.
- **DM reminders**: Sent ~30 minutes before each chore’s due time.
- **“Done” logging**: DM the bot “done” to mark your chore complete for the current week.
- **No Slack Pro required**.

## 1) Create a Slack App
1. Go to https://api.slack.com/apps → **Create New App** → From scratch.
2. Add **Bot Token Scopes** in *OAuth & Permissions*:
   - `chat:write`
   - `im:write`
   - `users:read`
   - `conversations.open`
   - `conversations.join` (so the bot can join your channel automatically)
3. Install the app to your workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`) and **Signing Secret**.
4. In your Slack workspace, create or pick a channel (e.g., `#house-chores`) and copy its channel ID (Channel → “About” → “Channel ID”).

> If you want to use the slash command `/assignchores`, add it under **Slash Commands** and point the Request URL to your deployed bot URL (Railway will give you one).

## 2) Configure the Bot
- Copy `.env.example` to `.env` and set:
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`
  - `CHANNEL_ID` (the channel to post weekly summary)
  - `TZ` (defaults to `America/Los_Angeles`)

- Copy `config.example.json` to `config.json` and edit:
  - Replace each roommate’s `slackId` with their real Slack User ID (Profile → … → Copy member ID).
  - Adjust chores and due times. `weekday` uses 0=Sun … 6=Sat.

## 3) Run Locally (optional)
```bash
npm install
node index.js
```
The bot runs on port 3000 by default. Cron + DMs will still work while the process is running.

## 4) Deploy on Railway (free plan)
1. Create an account at https://railway.app
2. New Project → **Empty Project**
3. Add a **Service** → “Deploy from GitHub” (or use the Files tab to upload these files).
4. In **Variables**, set:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `CHANNEL_ID`
   - `TZ` (optional)
5. Deploy. Keep the service running. The weekly cron (Sunday 8 PM PT) will run automatically.

## 5) Usage
- The bot posts assignments every Sunday evening.
- Each person gets a DM ~30 minutes before their chore is due.
- DM the bot the word **done** when you finish to log completion.
- Optional: Use slash command `/assignchores` to manually regenerate this week’s assignments.

## Notes
- History is stored in **data/history.json**. For persistence across redeploys on Railway, attach a *Volume* or switch to SQLite later.
- Fairness window is the last **8 weeks** by default.
- If there are more chores than people, someone may get more than one. The bot tries to avoid duplicates within a week.
