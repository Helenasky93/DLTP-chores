import pkg from '@slack/bolt';
const { App } = pkg;
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
  const roommates = config.roommates;
  const currentMonth = dayjs().tz(TZ).format('YYYY-M[MM]');
  
  // Get all assignments for current month
  const monthHistory = history.filter(h => h.month === currentMonth);
  
  // Count total monthly assignments for each person (across all chores)
  const monthlyCounts = {};
  roommates.forEach(r => monthlyCounts[r.slackId] = 0);
  
  monthHistory.forEach(h => {
    if (Array.isArray(h.assignedTo)) {
      // Handle multiple assignees
      h.assignedTo.forEach(assigneeId => {
        if (monthlyCounts[assigneeId] !== undefined) {
          monthlyCounts[assigneeId]++;
        }
      });
    } else {
      // Handle legacy single assignee format
      if (monthlyCounts[h.assignedTo] !== undefined) {
        monthlyCounts[h.assignedTo]++;
      }
    }
  });
  
  // Find person with fewest total monthly assignments
  const minCount = Math.min(...Object.values(monthlyCounts));
  const candidates = roommates.filter(r => monthlyCounts[r.slackId] === minCount);
  
  // Random selection among ties
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function findMultipleAssignees(chore, history, numAssignees = 2) {
  const roommates = config.roommates;
  const currentMonth = dayjs().tz(TZ).format('YYYY-M[MM]');
  
  // Get all assignments for current month
  const monthHistory = history.filter(h => h.month === currentMonth);
  
  // Count total monthly assignments for each person
  const monthlyCounts = {};
  roommates.forEach(r => monthlyCounts[r.slackId] = 0);
  
  monthHistory.forEach(h => {
    if (Array.isArray(h.assignedTo)) {
      h.assignedTo.forEach(assigneeId => {
        if (monthlyCounts[assigneeId] !== undefined) {
          monthlyCounts[assigneeId]++;
        }
      });
    } else {
      if (monthlyCounts[h.assignedTo] !== undefined) {
        monthlyCounts[h.assignedTo]++;
      }
    }
  });
  
  // Sort roommates by assignment count (ascending)
  const sortedRoommates = roommates.sort((a, b) => 
    monthlyCounts[a.slackId] - monthlyCounts[b.slackId]
  );
  
  // Return the N people with fewest assignments
  return sortedRoommates.slice(0, Math.min(numAssignees, roommates.length));
}

async function assignChores(isManual = false, weekOffset = 0) {
  const history = await loadHistory();
  const currentMonth = dayjs().tz(TZ).format('YYYY-M[MM]');
  const currentWeek = dayjs().tz(TZ).add(weekOffset, 'week').format('YYYY-[W]WW');
  
  // Check if already assigned this week
  const existingAssignments = history.filter(h => 
    h.week === currentWeek && !h.completed
  );
  if (existingAssignments.length > 0 && !isManual) {
    return existingAssignments;
  }
  
  const assignments = [];
  const assignedPeopleThisWeek = new Set();
  
  for (const chore of config.chores) {
    // Skip chores that are manually triggered (weekday: -1)
    if (chore.due.weekday === -1) continue;
    
    // Check if this chore is already completed this week
    const alreadyCompletedThisWeek = existingAssignments.find(h => 
      h.chore === chore.title && h.completed
    );
    
    if (alreadyCompletedThisWeek) {
      console.log(`Skipping ${chore.title} - already completed this week`);
      continue;
    }
    
    let assignee = findNextAssignee(chore, history);
    
    // Try to avoid giving same person multiple chores in one assignment batch
    let attempts = 0;
    while (assignedPeopleThisWeek.has(assignee.slackId) && attempts < config.roommates.length) {
      assignee = findNextAssignee(chore, history);
      attempts++;
    }
    
    assignedPeopleThisWeek.add(assignee.slackId);
    
    const assignment = {
      month: currentMonth,
      week: currentWeek,
      chore: chore.title,
      assignedTo: [assignee.slackId], // Array format for consistency
      assigneeNames: [assignee.name],
      date: dayjs().tz(TZ).toISOString(),
      dueDate: getNextDueDate(chore.due, weekOffset),
      completed: false,
      completedBy: []
    };
    
    assignments.push(assignment);
    history.push(assignment);
  }
  
  await saveHistory(history);
  return assignments;
}

function getNextDueDate(due, weekOffset = 0) {
  if (due.weekday === -1) return null;
  
  const now = dayjs().tz(TZ);
  let targetWeek = now.add(weekOffset, 'week');
  
  const nextDue = targetWeek
    .day(due.weekday)
    .hour(due.hour)
    .minute(due.minute)
    .second(0);
  
  // If scheduling for current week and it's already past due time, schedule for next week
  if (weekOffset === 0 && nextDue.isBefore(now)) {
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
    
    // Handle both single assignee (legacy) and multiple assignees
    let assigneeText = '';
    if (Array.isArray(assignment.assignedTo)) {
      assigneeText = assignment.assignedTo.map(id => `<@${id}>`).join(' & ');
    } else {
      // Legacy format
      assigneeText = `<@${assignment.assignedTo}>`;
    }
      
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${assignment.chore}*\n👤 ${assigneeText}\n📅 Due: ${dueText}`
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
        await showShareDialog(command, 'trash', respond);
      } else if (text.includes('dishwasher') && (text.includes('full') || text.includes('empty'))) {
        await showShareDialog(command, 'dishwasher', respond);
      } else if (text === 'assign' || text === '') {
        const assignments = await assignChores(true);
        await postAssignments(assignments, process.env.CHANNEL_ID);
        await respond('✅ Chores have been reassigned for this week!');
      } else if (text === 'chart' || text === 'progress') {
        await postDailyProgressChart();
        await respond('📊 Progress chart posted!');
      } else if (text === 'chart august' || text === 'chart aug') {
        await postSpecificMonthChart('2024-M08');
        await respond('📊 August 2024 chart posted!');
      } else {
        await respond('Try: `/chore assign` to reassign chores, `/chore chart` to show progress, or `/chore trash is full` for manual triggers');
      }
    } catch (error) {
      console.error('Error handling /chore command:', error);
      await respond('❌ Sorry, something went wrong!');
    }
  });
});

async function showShareDialog(command, choreType, respond) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${choreType === 'trash' ? '🗑️' : '🍽️'} How would you like to handle this chore?`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Solo Task'
          },
          action_id: 'solo_task',
          value: JSON.stringify({ type: choreType, userId: command.user_id }),
          style: 'primary'
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Shared Task'
          },
          action_id: 'shared_task',
          value: JSON.stringify({ type: choreType, userId: command.user_id })
        }
      ]
    }
  ];
  
  await respond({ blocks });
}

async function handleChoreAssignment(choreType, assignees, triggeredBy, respond) {
  const history = await loadHistory();
  let chore;
  
  if (choreType === 'trash') {
    chore = config.chores.find(c => c.title.toLowerCase().includes('trash'));
  } else if (choreType === 'dishwasher') {
    chore = config.chores.find(c => c.title.toLowerCase().includes('dish'));
  }
  
  if (!chore) {
    await respond(`❌ No ${choreType}-related chore found in config`);
    return;
  }
  
  const currentMonth = dayjs().tz(TZ).format('YYYY-M[MM]');
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  const assigneeIds = assignees.map(a => a.slackId);
  const assigneeNames = assignees.map(a => a.name);
  
  const assignment = {
    month: currentMonth,
    week: currentWeek,
    chore: chore.title,
    assignedTo: assigneeIds,
    assigneeNames: assigneeNames,
    date: dayjs().tz(TZ).toISOString(),
    dueDate: null,
    completed: false,
    completedBy: [],
    triggeredBy: triggeredBy
  };
  
  history.push(assignment);
  await saveHistory(history);
  
  const emoji = choreType === 'trash' ? '🗑️' : '🍽️';
  const assigneeText = assigneeIds.map(id => `<@${id}>`).join(' & ');
  await respond(`${emoji} *${chore.title}* has been assigned to ${assigneeText}!`);
  
  // DM all assignees
  for (const assigneeId of assigneeIds) {
    try {
      const dm = await app.client.conversations.open({
        token: process.env.SLACK_BOT_TOKEN,
        users: assigneeId
      });
      
      let message = `${emoji} Hey! You've been assigned: *${chore.title}*`;
      if (assigneeIds.length > 1) {
        const others = assigneeNames.filter((_, i) => assigneeIds[i] !== assigneeId);
        message += `\n\n👥 Shared with: ${others.join(', ')}`;
      }
      message += '\n\nReply "done" when complete!';
      
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: dm.channel.id,
        text: message
      });
    } catch (error) {
      console.error(`Error sending DM to ${assigneeId}:`, error);
    }
  }
}

// Handle solo task button click
app.action('solo_task', async ({ body, ack, respond }) => {
  await ack();
  
  const value = JSON.parse(body.actions[0].value);
  const history = await loadHistory();
  
  let chore;
  if (value.type === 'trash') {
    chore = config.chores.find(c => c.title.toLowerCase().includes('trash'));
  } else if (value.type === 'dishwasher') {
    chore = config.chores.find(c => c.title.toLowerCase().includes('dish'));
  }
  
  const assignee = findNextAssignee(chore, history);
  await handleChoreAssignment(value.type, [assignee], value.userId, respond);
});

// Handle shared task button click - show user selection
app.action('shared_task', async ({ body, ack, respond }) => {
  await ack();
  
  const value = JSON.parse(body.actions[0].value);
  
  // Show user selection interface
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '👥 Who will share this task? (Select 2-3 people)'
      }
    },
    {
      type: 'actions',
      elements: config.roommates.map(roommate => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: roommate.name
        },
        action_id: `select_${roommate.slackId}`,
        value: JSON.stringify({ 
          type: value.type, 
          userId: value.userId,
          selectedUsers: []
        })
      }))
    }
  ];
  
  await respond({ blocks });
});

// Track selected users for shared tasks
const sharedTaskSelections = new Map();

// Handle user selection for shared tasks
app.action(/select_U\w+/, async ({ body, ack, respond }) => {
  await ack();
  
  const selectedUserId = body.actions[0].action_id.replace('select_', '');
  const value = JSON.parse(body.actions[0].value);
  const selectionKey = `${value.userId}_${value.type}`;
  
  // Get or create selection list
  if (!sharedTaskSelections.has(selectionKey)) {
    sharedTaskSelections.set(selectionKey, []);
  }
  
  const selectedUsers = sharedTaskSelections.get(selectionKey);
  
  // Toggle selection
  if (selectedUsers.includes(selectedUserId)) {
    // Remove from selection
    sharedTaskSelections.set(selectionKey, selectedUsers.filter(id => id !== selectedUserId));
  } else {
    // Add to selection (max 3 people)
    if (selectedUsers.length < 3) {
      selectedUsers.push(selectedUserId);
      sharedTaskSelections.set(selectionKey, selectedUsers);
    }
  }
  
  const updatedSelection = sharedTaskSelections.get(selectionKey);
  const selectedNames = updatedSelection.map(id => 
    config.roommates.find(r => r.slackId === id)?.name
  ).filter(Boolean);
  
  // Update the interface
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👥 Selected: ${selectedNames.length > 0 ? selectedNames.join(', ') : 'None'} (${selectedNames.length}/3)`
      }
    },
    {
      type: 'actions',
      elements: [
        ...config.roommates.map(roommate => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: roommate.name
          },
          action_id: `select_${roommate.slackId}`,
          value: JSON.stringify({ 
            type: value.type, 
            userId: value.userId,
            selectedUsers: updatedSelection
          }),
          style: updatedSelection.includes(roommate.slackId) ? 'primary' : undefined
        })),
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Assign Task'
          },
          action_id: 'confirm_shared_assignment',
          value: JSON.stringify({ 
            type: value.type, 
            userId: value.userId,
            selectedUsers: updatedSelection
          }),
          style: 'primary'
        }
      ]
    }
  ];
  
  await respond({ blocks, replace_original: true });
});

// Handle final shared task assignment
app.action('confirm_shared_assignment', async ({ body, ack, respond }) => {
  await ack();
  
  const value = JSON.parse(body.actions[0].value);
  const selectionKey = `${value.userId}_${value.type}`;
  const selectedUserIds = sharedTaskSelections.get(selectionKey) || [];
  
  if (selectedUserIds.length === 0) {
    await respond({ text: '❌ Please select at least one person for the shared task.', replace_original: true });
    return;
  }
  
  const selectedUsers = selectedUserIds.map(id => 
    config.roommates.find(r => r.slackId === id)
  ).filter(Boolean);
  
  await handleChoreAssignment(value.type, selectedUsers, value.userId, respond);
  
  // Clean up selection tracking
  sharedTaskSelections.delete(selectionKey);
});

// Handle DM messages for "done" completion
app.message('done', async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  
  const history = await loadHistory();
  const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
  
  // Find user's incomplete assignments this week
  const userAssignments = history.filter(h => {
    if (h.week !== currentWeek || h.completed) return false;
    
    // Handle both legacy single assignee and new multiple assignee format
    if (Array.isArray(h.assignedTo)) {
      return h.assignedTo.includes(message.user);
    } else {
      return h.assignedTo === message.user;
    }
  });
  
  if (userAssignments.length === 0) {
    await say("🤔 I don't see any pending chores assigned to you this week.");
    return;
  }
  
  if (userAssignments.length === 1) {
    const assignment = userAssignments[0];
    
    // Mark as completed by this user
    if (!Array.isArray(assignment.completedBy)) {
      assignment.completedBy = [];
    }
    assignment.completedBy.push(message.user);
    
    // Check if all assignees have marked it complete
    const allAssignees = Array.isArray(assignment.assignedTo) ? assignment.assignedTo : [assignment.assignedTo];
    const allComplete = allAssignees.every(assigneeId => assignment.completedBy.includes(assigneeId));
    
    if (allComplete) {
      assignment.completed = true;
      assignment.completedDate = dayjs().tz(TZ).toISOString();
    }
    
    await saveHistory(history);
    
    if (allComplete) {
      await say(`✅ Great job completing: *${assignment.chore}*!`);
    } else {
      const remainingAssignees = allAssignees.filter(id => !assignment.completedBy.includes(id));
      const remainingNames = remainingAssignees.map(id => 
        config.roommates.find(r => r.slackId === id)?.name
      ).filter(Boolean);
      await say(`✅ Thanks! Marked as done. Waiting for: ${remainingNames.join(', ')}`);
    }
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
  
  const assignment = history.find(h => {
    if (h.week !== value.week || h.chore !== value.chore || h.completed) return false;
    
    // Handle both legacy and new format
    if (Array.isArray(h.assignedTo)) {
      return h.assignedTo.includes(body.user.id);
    } else {
      return h.assignedTo === body.user.id;
    }
  });
  
  if (assignment) {
    // Mark as completed by this user
    if (!Array.isArray(assignment.completedBy)) {
      assignment.completedBy = [];
    }
    assignment.completedBy.push(body.user.id);
    
    // Check if all assignees have marked it complete
    const allAssignees = Array.isArray(assignment.assignedTo) ? assignment.assignedTo : [assignment.assignedTo];
    const allComplete = allAssignees.every(assigneeId => assignment.completedBy.includes(assigneeId));
    
    if (allComplete) {
      assignment.completed = true;
      assignment.completedDate = dayjs().tz(TZ).toISOString();
    }
    
    await saveHistory(history);
    
    if (allComplete) {
      await say(`✅ Great job completing: *${assignment.chore}*!`);
    } else {
      const remainingAssignees = allAssignees.filter(id => !assignment.completedBy.includes(id));
      const remainingNames = remainingAssignees.map(id => 
        config.roommates.find(r => r.slackId === id)?.name
      ).filter(Boolean);
      await say(`✅ Thanks! Marked as done. Waiting for: ${remainingNames.join(', ')}`);
    }
  }
});

// Weekly assignment cron job - Every Monday at 8:00 AM PT
cron.schedule('0 8 * * 1', async () => {
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

// Monthly reset notification - 1st of each month at 9:00 AM PT
cron.schedule('0 9 1 * *', async () => {
  try {
    console.log('New month - resetting monthly tracking...');
    
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🗓️ New Month Started!'
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Monthly chore tracking has been reset. Everyone starts fresh! 💪'
        }
      }
    ];
    
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: process.env.CHANNEL_ID,
      blocks: blocks
    });
    
    console.log('Monthly reset notification posted!');
  } catch (error) {
    console.error('Error in monthly reset cron:', error);
  }
}, {
  timezone: TZ
});

// Daily progress chart - Every day at 10:00 AM PT
cron.schedule('0 10 * * *', async () => {
  try {
    console.log('Posting daily progress chart...');
    await postDailyProgressChart();
    console.log('Daily progress chart posted!');
  } catch (error) {
    console.error('Error in daily progress chart cron:', error);
  }
}, {
  timezone: TZ
});

async function postSpecificMonthChart(monthFilter) {
  const history = await loadHistory();
  const monthName = monthFilter === '2024-M08' ? 'August 2024' : 'Current Month';
  
  console.log('Filtering for month:', monthFilter);
  
  // Get all assignments for specified month
  const monthHistory = history.filter(h => h.month === monthFilter);
  
  console.log('Found history entries:', monthHistory.length);
  console.log('Sample entries:', monthHistory.slice(0, 2));
  
  // Calculate stats for each roommate
  const stats = {};
  config.roommates.forEach(roommate => {
    stats[roommate.slackId] = {
      name: roommate.name,
      total: 0,
      completed: 0,
      pending: 0,
      completedChores: []
    };
  });
  
  monthHistory.forEach(h => {
    const assigneeIds = Array.isArray(h.assignedTo) ? h.assignedTo : [h.assignedTo];
    assigneeIds.forEach(assigneeId => {
      if (stats[assigneeId]) {
        stats[assigneeId].total++;
        if (h.completed) {
          stats[assigneeId].completed++;
          stats[assigneeId].completedChores.push(h.chore);
        } else {
          stats[assigneeId].pending++;
        }
      }
    });
  });
  
  console.log('Final stats:', JSON.stringify(stats, null, 2));
  
  // Create progress chart blocks
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 ${monthName} Chore Progress`
      }
    },
    {
      type: 'divider'
    }
  ];
  
  // Sort roommates alphabetically (no competition/ranking)
  const sortedRoommates = Object.values(stats).sort((a, b) => a.name.localeCompare(b.name));
  
  sortedRoommates.forEach((stat) => {
    const completionRate = stat.total > 0 ? Math.round((stat.completed / stat.total) * 100) : 0;
    const progressBar = createProgressBar(completionRate);
    
    let choreList = '';
    if (stat.completedChores.length > 0) {
      choreList = `\\n✅ ${stat.completedChores.join(', ')}`;
    } else {
      choreList = '\\n📝 No completed chores yet';
    }
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${stat.name}*\\n${progressBar} ${stat.completed} completed${choreList}`
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
          text: `📅 Updated: ${dayjs().tz(TZ).format('MMM D, YYYY at h:mm A')}`
        }
      ]
    }
  );
  
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: process.env.CHANNEL_ID,
    blocks: blocks
  });
}

async function postDailyProgressChart() {
  const history = await loadHistory();
  const currentMonth = dayjs().tz(TZ).format('YYYY-M[MM]');
  const monthName = dayjs().tz(TZ).format('MMMM YYYY');
  
  console.log('Current month filter:', currentMonth);
  console.log('Month name:', monthName);
  
  // Get all assignments for current month
  const monthHistory = history.filter(h => h.month === currentMonth);
  
  // Calculate stats for each roommate
  const stats = {};
  config.roommates.forEach(roommate => {
    stats[roommate.slackId] = {
      name: roommate.name,
      total: 0,
      completed: 0,
      pending: 0,
      completedChores: []
    };
  });
  
  monthHistory.forEach(h => {
    const assigneeIds = Array.isArray(h.assignedTo) ? h.assignedTo : [h.assignedTo];
    assigneeIds.forEach(assigneeId => {
      if (stats[assigneeId]) {
        stats[assigneeId].total++;
        if (h.completed) {
          stats[assigneeId].completed++;
          stats[assigneeId].completedChores.push(h.chore);
        } else {
          stats[assigneeId].pending++;
        }
      }
    });
  });
  
  // Debug logging
  console.log('Month history count:', monthHistory.length);
  console.log('Stats:', JSON.stringify(stats, null, 2));
  
  // Create progress chart blocks
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 ${monthName} Chore Progress`
      }
    },
    {
      type: 'divider'
    }
  ];
  
  // Sort roommates alphabetically (no competition/ranking)
  const sortedRoommates = Object.values(stats).sort((a, b) => a.name.localeCompare(b.name));
  
  sortedRoommates.forEach((stat) => {
    const completionRate = stat.total > 0 ? Math.round((stat.completed / stat.total) * 100) : 0;
    const progressBar = createProgressBar(completionRate);
    
    let choreList = '';
    if (stat.completedChores.length > 0) {
      choreList = `\\n✅ ${stat.completedChores.join(', ')}`;
    } else {
      choreList = '\\n📝 No completed chores yet';
    }
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${stat.name}*\\n${progressBar} ${stat.completed} completed${choreList}`
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
          text: `📅 Updated: ${dayjs().tz(TZ).format('MMM D, YYYY at h:mm A')}`
        }
      ]
    }
  );
  
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: process.env.CHANNEL_ID,
    blocks: blocks
  });
}

function createProgressBar(percentage, length = 10) {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

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
      const assigneeIds = Array.isArray(chore.assignedTo) ? chore.assignedTo : [chore.assignedTo];
      
      for (const assigneeId of assigneeIds) {
        try {
          const dm = await app.client.conversations.open({
            token: process.env.SLACK_BOT_TOKEN,
            users: assigneeId
          });
          
          const dueText = dayjs(chore.dueDate).tz(TZ).format('h:mm A');
          let message = `⏰ Reminder: *${chore.chore}* is due at ${dueText} (in ~30 minutes)!`;
          
          // Add shared task info if applicable
          if (assigneeIds.length > 1) {
            const otherNames = chore.assigneeNames?.filter((name, i) => 
              (Array.isArray(chore.assignedTo) ? chore.assignedTo[i] : chore.assignedTo) !== assigneeId
            ) || [];
            if (otherNames.length > 0) {
              message += `\n\n👥 Shared with: ${otherNames.join(', ')}`;
            }
          }
          
          message += '\n\nReply "done" when complete!';
          
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: dm.channel.id,
            text: message
          });
        } catch (error) {
          console.error(`Error sending reminder for ${chore.chore} to ${assigneeId}:`, error);
        }
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

// Initialize this week's assignments (since it's mid-week)
async function initializeThisWeek() {
  try {
    const currentWeek = dayjs().tz(TZ).format('YYYY-[W]WW');
    const history = await loadHistory();
    
    // Check existing assignments for this week
    const existingAssignments = history.filter(h => h.week === currentWeek);
    const completedChores = existingAssignments.filter(h => h.completed);
    const scheduledChores = config.chores.filter(c => c.due.weekday !== -1);
    
    console.log(`Week ${currentWeek} status: ${completedChores.length}/${scheduledChores.length} chores completed`);
    
    if (completedChores.length >= scheduledChores.length) {
      console.log('✅ All scheduled chores for this week are already completed!');
      return;
    }
    
    // Try to assign remaining chores
    const assignments = await assignChores(false);
    
    if (assignments.length > 0) {
      await postAssignments(assignments, process.env.CHANNEL_ID);
      console.log(`✅ Posted ${assignments.length} remaining assignments for this week!`);
    } else {
      console.log('✅ No additional chore assignments needed this week.');
    }
  } catch (error) {
    console.error('Error initializing this week:', error);
  }
}

// Start the app
(async () => {
  await loadConfig();
  
  const port = process.env.PORT || 3000;
  await app.start(port);
  
  console.log(`⚡️ Slack ChoreBot is running on port ${port}!`);
  console.log(`Timezone: ${TZ}`);
  console.log(`Channel ID: ${process.env.CHANNEL_ID}`);
  console.log(`Roommates: ${config.roommates.map(r => r.name).join(', ')}`);
  
  // Initialize this week's assignments and post current progress
  setTimeout(async () => {
    await initializeThisWeek();
    // Post initial progress chart since we're starting mid-week
    setTimeout(async () => {
      try {
        console.log('Posting initial progress chart...');
        await postDailyProgressChart();
        console.log('✅ Initial progress chart posted!');
      } catch (error) {
        console.error('Error posting initial progress chart:', error);
      }
    }, 3000); // Wait another 3 seconds after assignments
  }, 2000); // Wait 2 seconds for everything to be ready
})();