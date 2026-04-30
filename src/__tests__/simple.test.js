import { describe, test, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../config/websocket.js', () => ({
    default: {
        emitMessageCreated: jest.fn(),
    }
}));

// Mock everything else to avoid side effects
jest.unstable_mockModule('../models/message.model.js', () => ({
    default: { 
        create: jest.fn().mockResolvedValue({ 
            _id: '1', 
            populate: jest.fn().mockReturnThis(),
            save: jest.fn().mockResolvedValue(true)
        }) 
    }
}));
jest.unstable_mockModule('../models/channel.model.js', () => ({
    default: { 
        findOne:           jest.fn().mockResolvedValue({ _id: '1' }),
        findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    }
}));
jest.unstable_mockModule('../services/workspace.service.js', () => ({
    assertMember: jest.fn().mockResolvedValue({ role: 'owner' })
}));

const { default: mockWs } = await import('../config/websocket.js');
const { sendMessage } = await import('../services/message.service.js');

describe('Service Mock Test', () => {
    test('mock is injected into service', async () => {
        try {
            await sendMessage('ws1', 'ch1', 'u1', { content: 'hello' });
        } catch (err) {
            console.error('sendMessage failed:', err);
            throw err;
        }
        expect(mockWs.emitMessageCreated).toHaveBeenCalled();
    });
});
