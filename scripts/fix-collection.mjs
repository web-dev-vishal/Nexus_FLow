import fs from 'fs';
const existing = fs.readFileSync('NexusFlow.postman_collection.json', 'utf8').trim();

const header = {
  info: {
    _postman_id: 'nexusflow-api-collection',
    name: 'NexusFlow API',
    description: 'Complete API collection for NexusFlow. Setup: 1. Set baseUrl to http://localhost:5000  2. Register then Login (tokens auto-saved)  3. Create Workspace then Create Channel (IDs auto-saved)',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:5000', type: 'string' },
    { key: 'accessToken', value: '', type: 'string' },
    { key: 'refreshToken', value: '', type: 'string' },
    { key: 'workspaceId', value: '', type: 'string' },
    { key: 'channelId', value: '', type: 'string' },
    { key: 'messageId', value: '', type: 'string' },
    { key: 'dmId', value: '', type: 'string' },
    { key: 'workflowId', value: '', type: 'string' },
    { key: 'executionId', value: '', type: 'string' },
    { key: 'userId', value: '', type: 'string' },
    { key: 'transactionId', value: '', type: 'string' },
    { key: 'webhookId', value: '', type: 'string' },
    { key: 'email', value: 'test@example.com', type: 'string' }
  ],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
  item: []
};

// The existing file contains the item array contents (groups) without the wrapper
// header JSON ends with ,"item":[]} — we strip the last 2 chars and append the items
const headerStr = JSON.stringify(header);
const full = headerStr.slice(0, -2) + existing + ']}';

try {
  const parsed = JSON.parse(full);
  fs.writeFileSync('NexusFlow.postman_collection.json', JSON.stringify(parsed, null, 2), 'utf8');
  const total = parsed.item.reduce((a, g) => a + (g.item ? g.item.length : 0), 0);
  console.log('SUCCESS - Groups:', parsed.item.length, '| Total requests:', total);
} catch(e) {
  const match = e.message.match(/position (\d+)/);
  if (match) {
    const pos = parseInt(match[1]);
    console.log('Parse error at pos', pos, ':', JSON.stringify(full.substring(pos - 40, pos + 40)));
  } else {
    console.log('Error:', e.message);
  }
}
