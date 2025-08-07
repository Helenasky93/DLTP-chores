import express from 'express';
import config from './config.json' assert { type: 'json' };
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

// Quick response to Slack to avoid timeout
app.post('/slack/events', (req, res) => {
  res.sendStatus(200); // Respond immediately
  // Later, add logic here to process events
  console.log('Slack event received:', req.body);
});

// Root test
app.get('/', (req, res) => {
  res.send('ChoreBot is alive!');
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
