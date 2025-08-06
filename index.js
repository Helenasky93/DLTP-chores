//
// ChoreBot – Slack bot for weekly fair chore assignments + DM reminders (full-auto)
//
// Requirements:
//  - Node 18+
//  - Slack App with Bot Token and Signing Secret
//  - Scopes: chat:write, im:write, users:read, conversations.open, conversations.join
//  - Env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, CHANNEL_ID, TZ (optional)
//
// Run locally:
//  1) cp .env.example .env and fill values
//  2) npm install
//  3) node index.js
//
// Deploy: See README.md
//

import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import pkg from '@slack/bolt';
const { App } = pkg;

dayjs.extend(utc);
dayjs.extend(tz);

const TZ = process.env.TZ || 'America/Los_Angeles';
const DATA_DIR = './data';
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = './config.json'; // copy from config.example.json and customize

await fs.ensureDir(DATA_DIR);
if (!(await fs.pathExists(HISTORY_FILE))) {
  await fs.writeJson(HISTORY_FILE, []);
}

async function loadConfig() {
  if (!(await fs.pathExists(CONFIG_FILE))) {
    throw new Error('Missing config.json. Copy config.example.json to config.json and customize it.');
  }
  const cfg = await fs.readJson(CONFIG_FILE);
  if (!cfg.roommates || !cfg.chores) throw new Error('config.json must have roommates and chores arrays.');
  return cfg;
}

async function loadHistory() {
  return fs.readJson(HISTORY_FILE);
}

async function saveHistory(history) {
  await fs.writeJson(HISTORY_FILE, history, { spaces: 2 });
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

const HOUSE_CHANNEL_ID = process.env.CHANNEL_ID; // e.g., C0123456789

async function ensureInChannel(channel) {
  try {
    await app.client.conversations.join({ channel });
  } catch (e) {
    // ignore errors for already_in_channel or private channels
  }
}

async function getImChannel(userId) {
  const res = await app.client.conversations.open({ users: userId });
  if (!res.ok) throw new Error(`Failed to open IM with ${userId}: ${res.error}`);
  return res.channel.id;
}

// Returns assignments for a given weekStart, array of { chore, roommateId, roommateName, dueAtISO }
function fairAssign({ roommates, chores }, history, weekStartISO) {
  const recentWeeks = 8;
  const weekStartDjs = dayjs.tz(weekStartISO, TZ).startOf('week'); // Sunday-start; adjust if desired

  const recent = history.filter(h => dayjs.tz(h.weekStartISO, TZ).isAfter(weekStartDjs.subtract(recentWeeks, 'week')));

  const counts = {};
  chores.forEach(c => {
    counts[c.title] = {};
    roommates.forEach(r => (counts[c.title][r.slackId] = 0));
  });

  recent.forEach(week => {
    week.assignments.forEach(a => {
      counts[a.chore] ??= {};
      counts[a.chore][a.roommateId] ??= 0;
      counts[a.chore][a.roommateId] += 1;
    });
  });

  const chosenThisWeek = new Set();
  function pickRoommateForChore(choreTitle) {
    const entries = Object.entries(counts[choreTitle]); // [ [roommateId, count], ...]
    const min = Math.min(...entries.map(([, c]) => c));
    const candidates = entries.filter(([, c]) => c === min).map(([id]) => id);
    const unassigned = candidates.filter(id => !chosenThisWeek.has(id));
    const pool = unassigned.length ? unassigned : candidates;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    chosenThisWeek.add(pick);
    return pick;
  }

  const assignments = chores.map(chore => {
    const roommateId = pickRoommateForChore(chore.title);
    const roommate = roommates.find(r => r.slackId === roommateId);

    let due = dayjs.tz(weekStartDjs, TZ).startOf('day');
    const targetW = chore.due.weekday; // 0=Sun .. 6=Sat
    const currentW = due.day();
    const addDays = (targetW - currentW + 7) % 7;
    due = due.add(addDays, 'day').hour(chore.due.hour || 20).minute(chore.due.minute || 0).second(0);

    return {
      chore: chore.title,
      roommateId,
      roommateName: roommate?.name || roommateId,
      dueAtISO: due.toISOString(),
    };
  });

  return assignments;
}

async function postWeeklyAndScheduleDMs({ roommates, chores }) {
  const weekStart = dayjs.tz(undefined, TZ).startOf('week').toISOString();
  const history = await loadHistory();
  const assignments = fairAssign({ roommates, chores }, history, weekStart);

  const lines = assignments.map(a => {
    const dueFmt = dayjs.tz(a.dueAtISO, TZ).format('ddd h:mm A');
    return `• *${a.chore}*: <@${a.roommateId}> (due ${dueFmt})`;
  });
  const text = `*This week's chores* (week of ${dayjs.tz(weekStart, TZ).format('MMM D')}):\n${lines.join('\n')}`;

  if (HOUSE_CHANNEL_ID) {
    await ensureInChannel(HOUSE_CHANNEL_ID);
    await app.client.chat.postMessage({ channel: HOUSE_CHANNEL_ID, text, mrkdwn: true });
  } else {
    console.warn('CHANNEL_ID not set; skipping channel post.');
  }

  for (const a of assignments) {
    try {
      const imChannel = await getImChannel(a.roommateId);
      const postAt = Math.max(Math.floor(dayjs(a.dueAtISO).unix()) - 60 * 30, Math.floor(dayjs().unix()) + 60); // 30 min before due
      const body = `Heads up: your chore this week is *${a.chore}*.\nIt's due at ${dayjs.tz(a.dueAtISO, TZ).format('ddd h:mm A')}.\nReply "done" here when finished.`;
      await app.client.chat.scheduleMessage({ channel: imChannel, text: body, post_at: postAt });
    } catch (err) {
      console.error('Failed to schedule DM:', err);
    }
  }

  history.push({ weekStartISO: weekStart, assignments, createdAtISO: dayjs().toISOString() });
  await saveHistory(history);
}

app.command('/assignchores', async ({ ack, say }) => {
  await ack();
  try {
    const cfg = await loadConfig();
    await postWeeklyAndScheduleDMs(cfg);
    await say('Chores assigned and reminders scheduled for this week ✅');
  } catch (e) {
    await say(`Error: ${e.message}`);
  }
});

app.message(/done/i, async ({ message, say }) => {
  try {
    const user = message.user;
    const text = (message.text || '').toLowerCase();
    if (!text.includes('done')) return;
    const history = await loadHistory();
    const latest = history[history.length - 1];
    if (!latest) return;
    const my = latest.assignments.find(a => a.roommateId === user);
    if (!my) return;
    my.completedAtISO = dayjs().toISOString();
    await saveHistory(history);
    await say(`Nice! Marked *${my.chore}* as completed for this week. 🙌`);
  } catch (e) {
    console.error(e);
  }
});

// Every Sunday at 8:00 PM in TZ
cron.schedule('0 20 * * 0', async () => {
  try {
    const cfg = await loadConfig();
    await postWeeklyAndScheduleDMs(cfg);
    console.log('Weekly assignments posted & DMs scheduled.');
  } catch (e) {
    console.error('Cron job error:', e);
  }
}, { timezone: TZ });

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('ChoreBot running on port', process.env.PORT || 3000, 'TZ', TZ);
})();
