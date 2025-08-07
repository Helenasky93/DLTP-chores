import pkg from '@slack/bolt';
const { App } = pkg;
import dotenv from 'dotenv';
import fs from 'fs-extra';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  processBeforeResponse: true
});

const CONFIG_FILE = './config.json';
const TZ = process.env.TZ || 'America/Los_Angeles';
const DB_PATH = process.env.DATABASE_URL || './chores.db';

let config = {};
let db;

// Initialize SQLite database
async function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database:', err);
        reject(err);
        return;
      }
      console.log('✅ Connected to SQLite database');
      
      // Create tables
      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS chore_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month TEXT NOT NULL,
            week TEXT NOT NULL,
            chore TEXT NOT NULL,
            assigned_to TEXT NOT NULL,
            assignee_names TEXT NOT NULL,
            date TEXT NOT NULL,
            due_date TEXT,
            completed BOOLEAN DEFAULT FALSE,
            completed_by TEXT DEFAULT '',
            completed_date TEXT,
            is_shared BOOLEAN DEFAULT FALSE,
            triggered_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) {
            console.error('Error creating table:', err);
            reject(err);
          } else {
            console.log('✅ Database table ready');
            resolve();
          }
        });
      });
    });
  });
}

// Promisify database methods
const dbAll = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

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
    const rows = await dbAll('SELECT * FROM chore_assignments ORDER BY created_at DESC');
    
    // Convert database rows to the format expected by existing code
    return rows.map(row => ({
      id: row.id,
      month: row.month,
      week: row.week,
      chore: row.chore,
      assignedTo: JSON.parse(row.assigned_to),
      assigneeNames: JSON.parse(row.assignee_names),
      date: row.date,
      dueDate: row.due_date,
      completed: Boolean(row.completed),
      completedBy: row.completed_by ? JSON.parse(row.completed_by) : [],
      completedDate: row.completed_date,
      isShared: Boolean(row.is_shared),
      triggeredBy: row.triggered_by
    }));
  } catch (error) {
    console.error('Error loading history from database:', error);
    return [];
  }
}

async function initializeSeedData() {
  try {
    // Check if data already exists
    const existingData = await dbAll('SELECT COUNT(*) as count FROM chore_assignments');
    if (existingData[0].count > 0) {
      console.log('Database already has data, skipping seed initialization');
      return;
    }

    const seedData = [
      // Kyle: 3 points total (2 trash + 1 vacuum)
      {
        month: "2025-M08", week: "2025-W31", chore: "Empty kitchen trash can and replace bag",
        assignedTo: ["U0997H3JB44"], assigneeNames: ["Kyle"], date: "2025-08-01T10:00:00.000Z",
        dueDate: null, completed: true, completedBy: ["U0997H3JB44"], completedDate: "2025-08-01T10:30:00.000Z", isShared: false
      },
      {
        month: "2025-M08", week: "2025-W32", chore: "Empty kitchen trash can and replace bag",
        assignedTo: ["U0997H3JB44"], assigneeNames: ["Kyle"], date: "2025-08-07T09:00:00.000Z",
        dueDate: null, completed: true, completedBy: ["U0997H3JB44"], completedDate: "2025-08-07T09:30:00.000Z", isShared: false
      },
      {
        month: "2025-M08", week: "2025-W31", chore: "Vacuum downstairs",
        assignedTo: ["U0997H3JB44"], assigneeNames: ["Kyle"], date: "2025-08-03T11:30:00.000Z",
        dueDate: "2025-08-03T12:00:00.000Z", completed: true, completedBy: ["U0997H3JB44"], completedDate: "2025-08-03T11:45:00.000Z", isShared: false
      },
      
      // Jimmy: 1.5 points total (1 trash + 0.5 shared take in bins)
      {
        month: "2025-M08", week: "2025-W31", chore: "Empty kitchen trash can and replace bag",
        assignedTo: ["U0997GV2P5J"], assigneeNames: ["Jimmy"], date: "2025-08-03T14:00:00.000Z",
        dueDate: null, completed: true, completedBy: ["U0997GV2P5J"], completedDate: "2025-08-03T14:15:00.000Z", isShared: false
      },
      {
        month: "2025-M08", week: "2025-W32", chore: "Take in trash bins to the yard",
        assignedTo: ["U0997GV2P5J", "U0997H0KM9A"], assigneeNames: ["Jimmy", "Max"], date: "2025-08-06T19:30:00.000Z",
        dueDate: "2025-08-06T20:00:00.000Z", completed: true, completedBy: ["U0997GV2P5J", "U0997H0KM9A"], completedDate: "2025-08-06T19:50:00.000Z", isShared: true
      },
      
      // Max: 0.5 points total (0.5 shared take in bins)
      // (Max already included in the shared task above)
      
      // Zo: 1 point total (1 vacuum)
      {
        month: "2025-M08", week: "2025-W31", chore: "Vacuum upstairs",
        assignedTo: ["U0997GWTXUL"], assigneeNames: ["Zo"], date: "2025-08-03T12:30:00.000Z",
        dueDate: "2025-08-03T13:00:00.000Z", completed: true, completedBy: ["U0997GWTXUL"], completedDate: "2025-08-03T12:45:00.000Z", isShared: false
      }
      
      // Helena: 0 points (no assignments)
    ];

    for (const assignment of seedData) {
      await saveAssignment(assignment);
    }
    
    console.log('✅ Database initialized with', seedData.length, 'historical entries');
  } catch (error) {
    console.error('Error initializing seed data:', error);
  }
}

async function saveAssignment(assignment) {
  try {
    await dbRun(`
      INSERT INTO chore_assignments (
        month, week, chore, assigned_to, assignee_names, date, due_date, 
        completed, completed_by, completed_date, is_shared, triggered_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      assignment.month,
      assignment.week,
      assignment.chore,
      JSON.stringify(assignment.assignedTo),
      JSON.stringify(assignment.assigneeNames),
      assignment.date,
      assignment.dueDate,
      assignment.completed ? 1 : 0,
      JSON.stringify(assignment.completedBy || []),
      assignment.completedDate,
      assignment.isShared ? 1 : 0,
      assignment.triggeredBy
    ]);
  } catch (error) {
    console.error('Error saving assignment:', error);
    throw error;
  }
}

async function updateAssignment(id, updates) {
  try {
    const setParts = [];
    const values = [];
    
    Object.keys(updates).forEach(key => {
      if (key === 'completedBy' || key === 'assignedTo' || key === 'assigneeNames') {
        setParts.push(`${key.replace(/([A-Z])/g, '_$1').toLowerCase()} = ?`);
        values.push(JSON.stringify(updates[key]));
      } else if (key === 'completed' || key === 'isShared') {
        setParts.push(`${key.replace(/([A-Z])/g, '_$1').toLowerCase()} = ?`);
        values.push(updates[key] ? 1 : 0);
      } else {
        setParts.push(`${key.replace(/([A-Z])/g, '_$1').toLowerCase()} = ?`);
        values.push(updates[key]);
      }
    });
    
    values.push(id);
    
    await dbRun(`
      UPDATE chore_assignments 
      SET ${setParts.join(', ')}
      WHERE id = ?
    `, values);
  } catch (error) {
    console.error('Error updating assignment:', error);
    throw error;
  }
}

function findNextAssignee(chore, history) {
  const roommates = config.roommates;
  const currentMonth = dayjs().tz(TZ).format('YYYY-[M]MM');
  
  // Get all assignments for current month
  const monthHistory = history.filter(h => h.month === currentMonth);
  
  // Count total monthly assignments for each person (across all chores)
  const monthlyCounts = {};
  roommates.forEach(r => monthlyCounts[r.slackId] = 0);
  
  monthHistory.forEach(h => {
    const assigneeIds = Array.isArray(h.assignedTo) ? h.assignedTo : [h.assignedTo];
    const isShared = h.isShared || assigneeIds.length > 1;
    const creditPerPerson = isShared ? 0.5 : 1;
    
    assigneeIds.forEach(assigneeId => {
      if (monthlyCounts[assigneeId] !== undefined) {
        monthlyCounts[assigneeId] += creditPerPerson;
      }
    });
  });
  
  // Find person with fewest total monthly assignments
  const minCount = Math.min(...Object.values(monthlyCounts));
  const candidates = roommates.filter(r => monthlyCounts[r.slackId] === minCount);
  
  // Random selection among ties
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function findMultipleAssignees(chore, history, numAssignees = 2) {
  const roommates = config.roommates;
  const currentMonth = dayjs().tz(TZ).format('YYYY-[M]MM');
  
  // Get all assignments for current month
  const monthHistory = history.filter(h => h.month === currentMonth);
  
  // Count total monthly assignments for each person
  const monthlyCounts = {};
  roommates.forEach(r => monthlyCounts[r.slackId] = 0);
  
  monthHistory.forEach(h => {
    const assigneeIds = Array.isArray(h.assignedTo) ? h.assignedTo : [h.assignedTo];
    const isShared = h.isShared || assigneeIds.length > 1;
    const creditPerPerson = isShared ? 0.5 : 1;
    
    assigneeIds.forEach(assigneeId => {
      if (monthlyCounts[assigneeId] !== undefined) {
        monthlyCounts[assigneeId] += creditPerPerson;
      }
    });
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
  const currentMonth = dayjs().tz(TZ).format('YYYY-[M]MM');
  const currentWeek = dayjs().tz(TZ).add(weekOffset, 'week').format('YYYY-[W]WW');
  
  // Get ALL assignments for this week (completed and incomplete)
  const allWeekAssignments = history.filter(h => h.week === currentWeek);
  
  // Get incomplete assignments for early return check
  const incompleteAssignments = allWeekAssignments.filter(h => !h.completed);
  if (incompleteAssignments.length > 0 && !isManual) {
    return incompleteAssignments;
  }
  
  // Get all scheduled chores (not manual ones)
  const scheduledChores = config.chores.filter(c => c.due.weekday !== -1);
  
  // Check if all scheduled chores are already completed
  const completedScheduledChores = scheduledChores.filter(chore => 
    allWeekAssignments.some(h => h.chore === chore.title && h.completed)
  );
  
  if (completedScheduledChores.length >= scheduledChores.length) {
    console.log('✅ All scheduled chores for this week are already completed!');
    return [];
  }
  
  const assignments = [];
  const assignedPeopleThisWeek = new Set();
  
  for (const chore of config.chores) {
    // Skip chores that are manually triggered (weekday: -1)
    if (chore.due.weekday === -1) continue;
    
    // Check if this chore is already completed this week
    const alreadyCompletedThisWeek = allWeekAssignments.find(h => 
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
    await saveAssignment(assignment);
  }
  
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
        await postSpecificMonthChart('2025-M08');
        await respond('📊 August 2025 chart posted!');
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
  
  const currentMonth = dayjs().tz(TZ).format('YYYY-[M]MM');
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
  
  await saveAssignment(assignment);
  
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

// Standalone chart command
app.command('/chart', async ({ command, ack, respond }) => {
  await ack();
  
  setImmediate(async () => {
    try {
      const text = command.text.trim().toLowerCase();
      
      if (text === 'august' || text === 'aug') {
        await postSpecificMonthChart('2025-M08');
        await respond('📊 August 2025 chart posted!');
      } else {
        await postDailyProgressChart();
        await respond('📊 Progress chart posted!');
      }
    } catch (error) {
      console.error('Error handling /chart command:', error);
      await respond('❌ Sorry, something went wrong!');
    }
  });
});

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
    if (!assignment.completedBy.includes(message.user)) {
      assignment.completedBy.push(message.user);
    }
    
    // Check if all assignees have marked it complete
    const allAssignees = Array.isArray(assignment.assignedTo) ? assignment.assignedTo : [assignment.assignedTo];
    const allComplete = allAssignees.every(assigneeId => assignment.completedBy.includes(assigneeId));
    
    const updates = {
      completedBy: assignment.completedBy
    };
    
    if (allComplete) {
      updates.completed = true;
      updates.completedDate = dayjs().tz(TZ).toISOString();
    }
    
    await updateAssignment(assignment.id, updates);
    
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
    if (!assignment.completedBy.includes(body.user.id)) {
      assignment.completedBy.push(body.user.id);
    }
    
    // Check if all assignees have marked it complete
    const allAssignees = Array.isArray(assignment.assignedTo) ? assignment.assignedTo : [assignment.assignedTo];
    const allComplete = allAssignees.every(assigneeId => assignment.completedBy.includes(assigneeId));
    
    const updates = {
      completedBy: assignment.completedBy
    };
    
    if (allComplete) {
      updates.completed = true;
      updates.completedDate = dayjs().tz(TZ).toISOString();
    }
    
    await updateAssignment(assignment.id, updates);
    
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
  const monthName = monthFilter === '2025-M08' ? 'August 2025' : 'Current Month';
  
  console.log('Filtering for month:', monthFilter);
  console.log('Total history records loaded:', history.length);
  
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
    const isShared = h.isShared || assigneeIds.length > 1;
    const creditPerPerson = isShared ? 0.5 : 1;
    
    assigneeIds.forEach(assigneeId => {
      if (stats[assigneeId]) {
        stats[assigneeId].total += creditPerPerson;
        if (h.completed) {
          stats[assigneeId].completed += creditPerPerson;
          const choreDisplay = isShared ? `${h.chore} (shared)` : h.chore;
          stats[assigneeId].completedChores.push(choreDisplay);
        } else {
          stats[assigneeId].pending += creditPerPerson;
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
    
    // Format the completion count nicely (show .5 as 0.5, whole numbers without decimals)
    const completedDisplay = stat.completed % 1 === 0 ? stat.completed.toString() : stat.completed.toFixed(1);
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${stat.name}*\\n${progressBar} ${completedDisplay} completed${choreList}`
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
  const currentMonth = dayjs().tz(TZ).format('YYYY-[M]MM');
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
    const isShared = h.isShared || assigneeIds.length > 1;
    const creditPerPerson = isShared ? 0.5 : 1;
    
    assigneeIds.forEach(assigneeId => {
      if (stats[assigneeId]) {
        stats[assigneeId].total += creditPerPerson;
        if (h.completed) {
          stats[assigneeId].completed += creditPerPerson;
          const choreDisplay = isShared ? `${h.chore} (shared)` : h.chore;
          stats[assigneeId].completedChores.push(choreDisplay);
        } else {
          stats[assigneeId].pending += creditPerPerson;
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
    
    // Format the completion count nicely (show .5 as 0.5, whole numbers without decimals)
    const completedDisplay = stat.completed % 1 === 0 ? stat.completed.toString() : stat.completed.toFixed(1);
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${stat.name}*\\n${progressBar} ${completedDisplay} completed${choreList}`
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
    
    console.log(`Week ${currentWeek} status: ${existingAssignments.length}/${scheduledChores.length} chores assigned, ${completedChores.length} completed`);
    
    if (existingAssignments.length >= scheduledChores.length) {
      console.log('✅ All scheduled chores for this week are already assigned!');
      return;
    }
    
    // Try to assign remaining chores
    const assignments = await assignChores(false);
    
    if (assignments.length > 0) {
      await postAssignments(assignments, process.env.CHANNEL_ID);
      console.log(`✅ Posted ${assignments.length} remaining assignments for this week!`);
    } else {
      // Check if all scheduled chores are completed for celebration message
      const completedScheduledChores = scheduledChores.filter(chore => 
        completedChores.some(h => h.chore === chore.title)
      );
      
      if (completedScheduledChores.length >= scheduledChores.length) {
        // Post celebratory message
        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🎉 *All auto assigned tasks have been completed for this week!*'
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Great job everyone! All scheduled chores for this week are done. 🧹✨'
            }
          }
        ];
        
        try {
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: process.env.CHANNEL_ID,
            blocks: blocks,
            text: '🎉 All auto assigned tasks have been completed for this week!'
          });
          console.log('✅ Posted celebratory completion message!');
        } catch (error) {
          console.error('Error posting celebratory message:', error);
        }
      } else {
        console.log('✅ No additional chore assignments needed this week.');
      }
    }
  } catch (error) {
    console.error('Error initializing this week:', error);
  }
}

// Start the app
(async () => {
  try {
    await initDatabase();
    await loadConfig();
    await initializeSeedData();
    
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
      }, 3000);
    }, 2000);
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();