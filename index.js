import { App } from '@slack/bolt';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  processBeforeResponse: true
});

const DATA_FILE = './data/history.json';
const CONFIG_FILE = './config.json';
const TZ = process.env.TZ || 'America/Los_Angeles';

let config = {};

async function loadConfig() {
  try {
    config = await fs.readJson(CONFIG_FILE);
  } catch (error) {
    console.error('Error loading config:', error);
    process.exit(1);
  }
}

async function loadHistory() {
  try {
    await fs.ensureDir('./data');
    const history = await fs.readJson(DATA_FILE);
    return Array.isArray(history) ? history : [];
  } catch (error) {
    return [];
  }
}

async function saveHistory(history) {
  await fs.ensureDir('./data');
  await fs.writeJson(DATA_FILE, history, { spaces: 2 });
}

function findNextAssignee(chore, history) {
  const choreHistory = history.filter(h => h.chore === chore.title);
  const roommates = config.roommates;
  
  // Count assignments for each person in the last 8 weeks
  const eightWeeksAgo = dayjs().subtract(8, 'weeks').toDate();
  const recentHistory = choreHistory.filter(h => new Date(h.date) > eightWeeksAgo);
  
  const counts = {};
  roommates.forEach(r => counts[r.slackId] = 0);
  recentHistory.forEach(h => {
    if (counts[h.assignedTo] !== undefined) {
      counts[h.assignedTo]++;
    }
  });
  
  // Find person with fewest assignments
  const minCount = Math.min(...Object.values(counts));
  const candidates = roommates.filter(r => counts[r.slackId] === minCount);
  
  // Random selection among ties
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function assignChores(isManual = false) {
  const history = await loadHistory();
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  
  // Check if already assigned this week
  const existingAssignments = history.filter(h => h.week === currentWeek);
  if (existingAssignments.length > 0 && !isManual) {
    return existingAssignments;
  }
  
  const assignments = [];
  const assignedPeople = new Set();
  
  for (const chore of config.chores) {
    // Skip chores that are manually triggered (weekday: -1)
    if (chore.due.weekday === -1) continue;
    
    let assignee = findNextAssignee(chore, history);
    
    // Try to avoid double assignments in the same week
    let attempts = 0;
    while (assignedPeople.has(assignee.slackId) && attempts < config.roommates.length) {
      assignee = findNextAssignee(chore, history);
      attempts++;
    }
    
    assignedPeople.add(assignee.slackId);
    
    const assignment = {
      week: currentWeek,
      chore: chore.title,
      assignedTo: assignee.slackId,
      assigneeName: assignee.name,
      date: dayjs().tz(TZ).toISOString(),
      dueDate: getNextDueDate(chore.due),
      completed: false
    };
    
    assignments.push(assignment);
    history.push(assignment);
  }
  
  await saveHistory(history);
  return assignments;
}

function getNextDueDate(due) {
  if (due.weekday === -1) return null;
  
  const now = dayjs().tz(TZ);
  const nextDue = now
    .day(due.weekday)
    .hour(due.hour)
    .minute(due.minute)
    .second(0);
  
  // If it's already past this week's due date, schedule for next week
  if (nextDue.isBefore(now)) {
    return nextDue.add(1, 'week').toISOString();
  }
  
  return nextDue.toISOString();
}

async function postAssignments(assignments, channelId) {
  if (assignments.length === 0) return;
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🏠 This Week\'s Chore Assignments'
      }
    },
    {
      type: 'divider'
    }
  ];
  
  assignments.forEach(assignment => {
    const dueText = assignment.dueDate 
      ? dayjs(assignment.dueDate).tz(TZ).format('dddd, MMM D at h:mm A')
      : 'No specific due date';
      
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${assignment.chore}*\n👤 <@${assignment.assignedTo}>\n📅 Due: ${dueText}`
      }
    });
  });
  
  blocks.push(
    {
      type: 'divider'
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'DM me "done" when you complete your chore! 💪'
        }
      ]
    }
  );
  
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: channelId,
    blocks: blocks
  });
}

// Slash command handler with immediate response
app.command('/chore', async ({ command, ack, respond, client }) => {
  await ack();
  
  // Process asynchronously to avoid timeout
  setImmediate(async () => {
    try {
      const text = command.text.trim().toLowerCase();
      
      if (text.includes('trash') && text.includes('full')) {
        await handleTrashFull(command.user_id, respond);
      } else if (text.includes('dishwasher') && (text.includes('full') || text.includes('empty'))) {
        await handleDishwasher(command.user_id, respond);
      } else if (text === 'assign' || text === '') {
        const assignments = await assignChores(true);
        await postAssignments(assignments, process.env.CHANNEL_ID);
        await respond('✅ Chores have been reassigned for this week!');
      } else {
        await respond('Try: `/chore assign` to reassign chores, or `/chore trash is full` for manual triggers');
      }
    } catch (error) {
      console.error('Error handling /chore command:', error);
      await respond('❌ Sorry, something went wrong!');
    }
  });
});

async function handleTrashFull(userId, respond) {
  const history = await loadHistory();
  const trashChore = config.chores.find(c => c.title.toLowerCase().includes('trash'));
  
  if (!trashChore) {
    await respond('❌ No trash-related chore found in config');
    return;
  }
  
  const assignee = findNextAssignee(trashChore, history);
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  
  const assignment = {
    week: currentWeek,
    chore: trashChore.title,
    assignedTo: assignee.slackId,
    assigneeName: assignee.name,
    date: dayjs().tz(TZ).toISOString(),
    dueDate: null,
    completed: false,
    triggeredBy: userId
  };
  
  history.push(assignment);
  await saveHistory(history);
  
  await respond(`🗑️ *${trashChore.title}* has been assigned to <@${assignee.slackId}>!`);
  
  // DM the assignee
  try {
    const dm = await app.client.conversations.open({
      token: process.env.SLACK_BOT_TOKEN,
      users: assignee.slackId
    });
    
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: dm.channel.id,
      text: `🗑️ Hey! The trash is full - you've been assigned: *${trashChore.title}*\n\nReply "done" when complete!`
    });
  } catch (error) {
    console.error('Error sending DM:', error);
  }
}

async function handleDishwasher(userId, respond) {
  const history = await loadHistory();
  const dishChore = config.chores.find(c => c.title.toLowerCase().includes('dish'));
  
  if (!dishChore) {
    await respond('❌ No dishwasher-related chore found in config');
    return;
  }
  
  const assignee = findNextAssignee(dishChore, history);
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  
  const assignment = {
    week: currentWeek,
    chore: dishChore.title,
    assignedTo: assignee.slackId,
    assigneeName: assignee.name,
    date: dayjs().tz(TZ).toISOString(),
    dueDate: null,
    completed: false,
    triggeredBy: userId
  };
  
  history.push(assignment);
  await saveHistory(history);
  
  await respond(`🍽️ *${dishChore.title}* has been assigned to <@${assignee.slackId}>!`);
  
  // DM the assignee
  try {
    const dm = await app.client.conversations.open({
      token: process.env.SLACK_BOT_TOKEN,
      users: assignee.slackId
    });
    
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: dm.channel.id,
      text: `🍽️ Hey! The dishwasher needs attention - you've been assigned: *${dishChore.title}*\n\nReply "done" when complete!`
    });
  } catch (error) {
    console.error('Error sending DM:', error);
  }
}

// Handle DM messages for "done" completion
app.message('done', async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  
  const history = await loadHistory();
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  
  // Find user's incomplete assignments this week
  const userAssignments = history.filter(h => 
    h.assignedTo === message.user && 
    h.week === currentWeek && 
    !h.completed
  );
  
  if (userAssignments.length === 0) {
    await say("🤔 I don't see any pending chores assigned to you this week.");
    return;
  }
  
  if (userAssignments.length === 1) {
    userAssignments[0].completed = true;
    userAssignments[0].completedDate = dayjs().tz(TZ).toISOString();
    await saveHistory(history);
    await say(`✅ Great job completing: *${userAssignments[0].chore}*!`);
  } else {
    // Multiple assignments - ask which one
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Which chore did you complete?'
        }
      },
      {
        type: 'actions',
        elements: userAssignments.map((assignment, index) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: assignment.chore
          },
          action_id: `complete_${index}`,
          value: JSON.stringify({ week: assignment.week, chore: assignment.chore })
        }))
      }
    ];
    
    await say({ blocks });
  }
});

// Handle completion button clicks
app.action(/complete_\d+/, async ({ body, ack, say }) => {
  await ack();
  
  const value = JSON.parse(body.actions[0].value);
  const history = await loadHistory();
  
  const assignment = history.find(h => 
    h.assignedTo === body.user.id && 
    h.week === value.week && 
    h.chore === value.chore &&
    !h.completed
  );
  
  if (assignment) {
    assignment.completed = true;
    assignment.completedDate = dayjs().tz(TZ).toISOString();
    await saveHistory(history);
    await say(`✅ Great job completing: *${assignment.chore}*!`);
  }
});

// Weekly assignment cron job - Sundays at 8:00 PM PT
cron.schedule('0 20 * * 0', async () => {
  try {
    console.log('Running weekly chore assignment...');
    const assignments = await assignChores();
    await postAssignments(assignments, process.env.CHANNEL_ID);
    console.log('Weekly assignments posted!');
  } catch (error) {
    console.error('Error in weekly assignment cron:', error);
  }
}, {
  timezone: TZ
});

// DM reminder system - check every hour
cron.schedule('0 * * * *', async () => {
  try {
    const history = await loadHistory();
    const now = dayjs().tz(TZ);
    const in30Minutes = now.add(30, 'minutes');
    
    // Find assignments due in about 30 minutes
    const upcomingChores = history.filter(h => {
      if (h.completed || !h.dueDate) return false;
      
      const dueTime = dayjs(h.dueDate).tz(TZ);
      return dueTime.isAfter(now) && dueTime.isBefore(in30Minutes);
    });
    
    for (const chore of upcomingChores) {
      try {
        const dm = await app.client.conversations.open({
          token: process.env.SLACK_BOT_TOKEN,
          users: chore.assignedTo
        });
        
        const dueText = dayjs(chore.dueDate).tz(TZ).format('h:mm A');
        
        await app.client.chat.postMessage({
          token: process.env.SLACK_BOT_TOKEN,
          channel: dm.channel.id,
          text: `⏰ Reminder: *${chore.chore}* is due at ${dueText} (in ~30 minutes)!\n\nReply "done" when complete!`
        });
      } catch (error) {
        console.error(`Error sending reminder for ${chore.chore}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in reminder cron:', error);
  }
}, {
  timezone: TZ
});

// Error handling
app.error((error) => {
  console.error('Slack app error:', error);
});

// Start the app
(async () => {
  await loadConfig();
  
  const port = process.env.PORT || 3000;
  await app.start(port);
  
  console.log(`⚡️ Slack ChoreBot is running on port ${port}!`);
  console.log(`Timezone: ${TZ}`);
  console.log(`Channel ID: ${process.env.CHANNEL_ID}`);
  console.log(`Roommates: ${config.roommates.map(r => r.name).join(', ')}`);
})();