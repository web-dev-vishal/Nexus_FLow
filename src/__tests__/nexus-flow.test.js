import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mocking all external dependencies for isolated service testing
jest.unstable_mockModule('../models/message.model.js', () => ({
    default: {
        create:  jest.fn(),
        findOne: jest.fn(),
        findById: jest.fn(),
        save:    jest.fn(),
    }
}));

jest.unstable_mockModule('../models/channel.model.js', () => ({
    default: {
        findOne: jest.fn(),
        findByIdAndUpdate: jest.fn(),
    }
}));

jest.unstable_mockModule('../models/direct-message.model.js', () => ({
    default: {
        findOne:           jest.fn(),
        findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    }
}));

jest.unstable_mockModule('../models/notification.model.js', () => ({
    default: {
        create:      jest.fn(),
        insertMany:  jest.fn().mockResolvedValue([]),
    }
}));

jest.unstable_mockModule('../services/workspace.service.js', () => ({
    assertMember: jest.fn().mockResolvedValue({ role: 'owner' }),
}));

jest.unstable_mockModule('../config/websocket.js', () => ({
    default: {
        emitMessageCreated: jest.fn(),
        emitMessageUpdated: jest.fn(),
        emitMessageDeleted: jest.fn(),
        emitReactionUpdated: jest.fn(),
    }
}));

jest.unstable_mockModule('../services/groq.service.js', () => ({
    default: jest.fn().mockImplementation(() => ({
        chat: jest.fn().mockResolvedValue("AI Response"),
    })),
}));

// Import services after mocks are established
const { sendMessage } = await import('../services/message.service.js');
const { sendDMMessage } = await import('../services/dm.service.js');

// Get the mocked instances to check expectations
const { default: Message } = await import('../models/message.model.js');
const { default: Channel } = await import('../models/channel.model.js');
const { default: DM }      = await import('../models/direct-message.model.js');
const { default: mockWs }  = await import('../config/websocket.js');

describe('NexusFlow (Chat) WebSocket Emissions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('sendMessage calls WebSocket emission', async () => {
        const msgData = {
            _id: 'msg123',
            workspaceId: 'ws1',
            channelId: 'ch1',
            senderId: 'u1',
            content: 'hello',
            populate: jest.fn().mockReturnThis(),
            save: jest.fn().mockResolvedValue(true),
        };
        Message.create.mockResolvedValue(msgData);
        Channel.findOne.mockResolvedValue({ _id: 'ch1' });

        await sendMessage('ws1', 'ch1', 'u1', { content: 'hello' });

        expect(Message.create).toHaveBeenCalled();
        expect(mockWs.emitMessageCreated).toHaveBeenCalled();
    });

    test('sendDMMessage calls WebSocket emission', async () => {
        const msgData = {
            _id: 'msg456',
            workspaceId: 'ws1',
            dmId: 'dm1',
            senderId: 'u1',
            content: 'hi dm',
            populate: jest.fn().mockReturnThis(),
            save: jest.fn().mockResolvedValue(true),
        };
        Message.create.mockResolvedValue(msgData);
        DM.findOne.mockReturnValue({
            populate: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: 'dm1',
                    participants: [{ _id: 'u1' }, { _id: 'u2' }],
                    closedBy: [],
                }),
            }),
        });

        await sendDMMessage('ws1', 'dm1', 'u1', { content: 'hi dm' });

        expect(Message.create).toHaveBeenCalled();
        expect(mockWs.emitMessageCreated).toHaveBeenCalled();
    });
});
