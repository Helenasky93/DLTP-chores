const config = {
  chores: [
    {
      title: "vacuum downstairs",
      frequency: "weekly",
      trigger: "vacuum downstairs"
    },
    {
      title: "vacuum upstairs",
      frequency: "weekly",
      trigger: "vacuum upstairs"
    },
    {
      title: "empty kitchen trash can and replace bag",
      frequency: "as_needed",
      trigger: "trash is full"
    },
    {
      title: "take out trash bins to the front",
      frequency: "weekly",
      trigger: "trash day"
    },
    {
      title: "take in trash bins to the yard",
      frequency: "weekly",
      trigger: "bins are back"
    },
    {
      title: "put away dishes from dishwasher",
      frequency: "as_needed",
      trigger: "dishwasher needs emptying"
    }
  ],
  roommates: [
    {
      name: "Helena",
      slackId: "Uxxxxxxx1"
    },
    {
      name: "Zo",
      slackId: "Uxxxxxxx2"
    },
    {
      name: "Jimmy",
      slackId: "Uxxxxxxx3"
    },
    {
      name: "Kyle",
      slackId: "Uxxxxxxx4"
    },
    {
      name: "Max",
      slackId: "Uxxxxxxx5"
    }
  ]
};
export default config;
