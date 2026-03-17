import { afterEach, describe, expect, it, vi } from 'vitest';
import telegramService, {
	buildReplyContent,
	parseComposeCallbackData,
	parseRecipientInput,
	replySubject
} from '../src/service/telegram-service';
import emailService from '../src/service/email-service';

describe('telegram compose helpers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('parses callback payloads', () => {
		expect(parseComposeCallbackData('cmp|sender|12')).toEqual({
			action: 'sender',
			value: '12'
		});
		expect(parseComposeCallbackData('bad|sender|12')).toBeNull();
	});

	it('parses recipient input and removes duplicates', () => {
		expect(parseRecipientInput('a@example.com, b@example.com a@example.com bad')).toEqual({
			valid: ['a@example.com', 'b@example.com'],
			invalid: ['bad']
		});
	});

	it('builds reply subjects and quoted content', () => {
		expect(replySubject('Hello')).toBe('Re: Hello');
		expect(replySubject('Re: Hello')).toBe('Re: Hello');

		const replyContent = buildReplyContent('Thanks', {
			name: 'Alice',
			sendEmail: 'alice@example.com',
			createTime: '2026-03-01 12:30:00',
			quoteText: 'Original line'
		});

		expect(replyContent.text).toContain('On 2026-03-01 12:30:00 Alice <alice@example.com> wrote:');
		expect(replyContent.text).toContain('> Original line');
		expect(replyContent.html).toContain('<blockquote');
		expect(replyContent.html).toContain('Original line');
	});
});

describe('telegram compose send flow', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends compose drafts with admin account context', async () => {
		const draft = {
			...telegramService.emptyDraft('compose'),
			accountId: 7,
			receiveEmail: ['user@example.com'],
			subject: 'Hello',
			bodyText: 'Plain body',
			step: 'confirm'
		};

		vi.spyOn(telegramService, 'resolveAdminContext').mockResolvedValue({
			user: { userId: 99 },
			accounts: [{ accountId: 7, email: 'admin@example.com', name: 'Admin' }]
		});
		const sendSpy = vi.spyOn(emailService, 'send').mockResolvedValue([{ emailId: 321 }]);
		const clearSpy = vi.spyOn(telegramService, 'clearDraft').mockResolvedValue();
		const sendTextSpy = vi.spyOn(telegramService, 'sendText').mockResolvedValue();

		await telegramService.sendComposeDraft({}, '100', draft);

		expect(sendSpy).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				accountId: 7,
				name: 'Admin',
				sendType: '',
				emailId: 0,
				receiveEmail: ['user@example.com'],
				subject: 'Hello',
				attachments: []
			}),
			99
		);

		const payload = sendSpy.mock.calls[0][1];
		expect(payload.text).toBe('Plain body');
		expect(payload.content).toContain('Plain body');
		expect(clearSpy).toHaveBeenCalledWith({}, '100');
		expect(sendTextSpy).toHaveBeenCalledWith({}, '100', expect.stringContaining('发送成功'));
	});

	it('sends reply drafts with thread headers when messageId exists', async () => {
		const draft = {
			...telegramService.emptyDraft('reply'),
			accountId: 7,
			receiveEmail: ['alice@example.com'],
			subject: 'Re: Hello',
			bodyText: 'Reply body',
			replyEmailId: 55,
			replyMessageId: '<msg-1@example.com>',
			replyMeta: {
				emailId: 55,
				name: 'Alice',
				sendEmail: 'alice@example.com',
				subject: 'Hello',
				createTime: '2026-03-01 12:30:00',
				quoteText: 'Original line'
			},
			step: 'confirm'
		};

		vi.spyOn(telegramService, 'resolveAdminContext').mockResolvedValue({
			user: { userId: 99 },
			accounts: [{ accountId: 7, email: 'admin@example.com', name: 'Admin' }]
		});
		const sendSpy = vi.spyOn(emailService, 'send').mockResolvedValue([{ emailId: 322 }]);
		vi.spyOn(telegramService, 'clearDraft').mockResolvedValue();
		vi.spyOn(telegramService, 'sendText').mockResolvedValue();

		await telegramService.sendComposeDraft({}, '100', draft);

		const payload = sendSpy.mock.calls[0][1];
		expect(payload.sendType).toBe('reply');
		expect(payload.emailId).toBe(55);
		expect(payload.text).toContain('On 2026-03-01 12:30:00 Alice <alice@example.com> wrote:');
		expect(payload.content).toContain('<blockquote');
	});

	it('keeps drafts on send failure and reopens confirm step', async () => {
		const draft = {
			...telegramService.emptyDraft('compose'),
			accountId: 7,
			receiveEmail: ['user@example.com'],
			subject: 'Hello',
			bodyText: 'Plain body',
			step: 'confirm'
		};

		vi.spyOn(telegramService, 'resolveAdminContext').mockResolvedValue({
			user: { userId: 99 },
			accounts: [{ accountId: 7, email: 'admin@example.com', name: 'Admin' }]
		});
		vi.spyOn(emailService, 'send').mockRejectedValue(new Error('boom'));
		const saveSpy = vi.spyOn(telegramService, 'saveDraft').mockResolvedValue();
		const previewSpy = vi.spyOn(telegramService, 'sendComposePreview').mockResolvedValue();
		const sendTextSpy = vi.spyOn(telegramService, 'sendText').mockResolvedValue();

		await telegramService.sendComposeDraft({}, '100', draft);

		expect(draft.step).toBe('confirm');
		expect(saveSpy).toHaveBeenCalled();
		expect(previewSpy).toHaveBeenCalledWith({}, '100', draft);
		expect(sendTextSpy).toHaveBeenCalledWith({}, '100', expect.stringContaining('发送失败'));
	});

	it('moves recipient editing back to subject or confirm based on draft state', async () => {
		const firstDraft = {
			...telegramService.emptyDraft('compose'),
			accountId: 7,
			step: 'recipient'
		};
		const secondDraft = {
			...telegramService.emptyDraft('compose'),
			accountId: 7,
			subject: 'Hello',
			bodyText: 'Ready',
			step: 'recipient'
		};

		const saveSpy = vi.spyOn(telegramService, 'saveDraft').mockResolvedValue();
		const showSpy = vi.spyOn(telegramService, 'showComposeStep').mockResolvedValue();

		await telegramService.applyRecipientInput({}, '100', firstDraft, 'a@example.com b@example.com');
		expect(firstDraft.receiveEmail).toEqual(['a@example.com', 'b@example.com']);
		expect(firstDraft.step).toBe('subject');

		await telegramService.applyRecipientInput({}, '100', secondDraft, 'c@example.com');
		expect(secondDraft.receiveEmail).toEqual(['c@example.com']);
		expect(secondDraft.step).toBe('confirm');
		expect(saveSpy).toHaveBeenCalledTimes(2);
		expect(showSpy).toHaveBeenCalledTimes(2);
	});
});
