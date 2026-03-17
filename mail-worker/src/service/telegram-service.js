import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import domainUtils from '../utils/domain-uitls';
import { emailConst, isDel } from '../const/entity-const';
import userService from './user-service';
import roleService from './role-service';
import accountService from './account-service';
import emailService from './email-service';
import analysisDao from '../dao/analysis-dao';
import r2Service from './r2-service';
import KvConst from '../const/kv-const';
import dayjs from 'dayjs';
import cryptoUtils from '../utils/crypto-utils';
import verifyUtils from '../utils/verify-utils';
import { parseHTML } from 'linkedom';

const TELEGRAM_MESSAGE_LIMIT = 3900;
const TELEGRAM_SENDER_PAGE_SIZE = 8;
const TELEGRAM_DRAFT_TTL = 60 * 60 * 24;
const COMPOSE_CALLBACK_PREFIX = 'cmp';
const COMPOSE_STEPS = ['sender', 'recipient', 'subject', 'body', 'confirm'];
const COMPOSE_EDITABLE_STEPS = ['sender', 'recipient', 'subject', 'body'];

function normalizeText(text = '') {
	return String(text).replace(/\r\n/g, '\n').trim();
}

function quotePlainText(text = '') {
	return normalizeText(text)
		.split('\n')
		.map(line => `> ${line}`)
		.join('\n');
}

export function escapeHtml(value = '') {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function textToHtml(text = '') {
	const normalized = normalizeText(text);
	if (!normalized) {
		return '';
	}
	return `<div style="white-space: pre-wrap;">${escapeHtml(normalized).replace(/\n/g, '<br>')}</div>`;
}

export function replySubject(subject = '') {
	const value = (subject || '').trim();
	if (!value) {
		return 'Re: (无主题)';
	}
	if (
		value.startsWith('Re:') ||
		value.startsWith('Re：') ||
		value.startsWith('回复:') ||
		value.startsWith('回复：')
	) {
		return value;
	}
	return `Re: ${value}`;
}

export function parseRecipientInput(text = '') {
	const rawList = String(text)
		.split(/[\s,，]+/)
		.map(item => item.trim())
		.filter(Boolean);

	const uniqueList = [...new Set(rawList)];
	const valid = [];
	const invalid = [];

	uniqueList.forEach(item => {
		if (verifyUtils.isEmail(item)) {
			valid.push(item);
		} else {
			invalid.push(item);
		}
	});

	return { valid, invalid };
}

export function parseComposeCallbackData(data = '') {
	const [prefix, action, value = ''] = String(data).split('|');
	if (prefix !== COMPOSE_CALLBACK_PREFIX || !action) {
		return null;
	}
	return { action, value };
}

export function buildReplyContent(bodyText, replyMeta = {}) {
	const normalizedBody = normalizeText(bodyText);
	const quoteText = normalizeText(replyMeta.quoteText || '(无正文)');
	const senderName = replyMeta.name || '';
	const senderEmail = replyMeta.sendEmail || '';
	const createTime = replyMeta.createTime || '';
	const headerText = `On ${createTime} ${senderName} <${senderEmail}> wrote:`;

	return {
		text: [normalizedBody, '', headerText, quotePlainText(quoteText)].join('\n').trim(),
		html:
			`${textToHtml(normalizedBody)}` +
			`<div><br></div>` +
			`<div>${escapeHtml(headerText)}</div>` +
			`<blockquote style="margin: 0 0 0 0.8ex;border-left: 1px solid rgb(204,204,204);padding-left: 1ex;">` +
			`<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${escapeHtml(quoteText)}</pre>` +
			`</blockquote>`
	};
}

const telegramService = {

	async webhook(c, params, body) {

		try {

			const { secret } = params;

			if (secret !== c.env.jwt_secret) {
				return;
			}

			if (body?.callback_query) {
				await this.handleCallbackQuery(c, body.callback_query);
				return;
			}

			const msg = body?.message || body?.edited_message;

			if (!msg) {
				return;
			}

			const chatId = String(msg?.chat?.id || '');

			if (!chatId) {
				return;
			}

			const allowChatIds = await this.allowChatIds(c);

			if (!allowChatIds.includes(chatId)) {
				return;
			}

			const rawText = typeof msg?.text === 'string' ? msg.text : '';

			if (!rawText.trim()) {
				return;
			}

			const commandData = this.parseCommand(rawText);

			if (commandData) {
				await this.handleCommand(c, chatId, commandData);
				return;
			}

			await this.handleDraftText(c, chatId, rawText);

		} catch (e) {
			console.error('Telegram webhook error:', e);
		}

	},

	async handleCommand(c, chatId, commandData) {
		const { command, argsText, argsList } = commandData;

		if (command === '/start') {
			await this.sendStart(c, chatId);
			return;
		}

		if (command === '/help') {
			await this.sendHelp(c, chatId);
			return;
		}

		if (command === '/compose') {
			await this.startComposeCommand(c, chatId);
			return;
		}

		if (command === '/reply') {
			await this.startReplyCommand(c, chatId, argsList);
			return;
		}

		if (command === '/cancel') {
			await this.cancelComposeCommand(c, chatId);
			return;
		}

		if (command === '/inbox') {
			await this.sendInbox(c, chatId, argsList);
			return;
		}

		if (command === '/search') {
			await this.searchInbox(c, chatId, argsText);
			return;
		}

		if (command === '/mail') {
			await this.showMail(c, chatId, argsList);
			return;
		}

		if (command === '/mailraw') {
			await this.showMailRaw(c, chatId, argsList);
			return;
		}

		if (command === '/unread') {
			await this.sendUnread(c, chatId, argsList);
			return;
		}

		if (command === '/status') {
			await this.sendStatus(c, chatId);
			return;
		}

		if (command === '/stats') {
			await this.sendStats(c, chatId, argsList);
			return;
		}

		if (command === '/roles') {
			await this.sendRoles(c, chatId);
			return;
		}

		if (command === '/users') {
			await this.searchUsers(c, chatId, argsText);
			return;
		}

		if (command === '/user') {
			await this.showUser(c, chatId, argsList);
			return;
		}

		if (command === '/adduser') {
			await this.addUserCommand(c, chatId, argsList);
			return;
		}

		await this.sendText(c, chatId, '不支持的命令，请输入 /help 查看可用命令。');
	},

	async handleCallbackQuery(c, callbackQuery) {

		const chatId = String(callbackQuery?.message?.chat?.id || '');

		if (!chatId) {
			return;
		}

		const allowChatIds = await this.allowChatIds(c);

		if (!allowChatIds.includes(chatId)) {
			return;
		}

		const actionData = parseComposeCallbackData(callbackQuery?.data);

		if (!actionData) {
			await this.answerCallback(c, callbackQuery.id);
			return;
		}

		await this.handleComposeCallback(c, chatId, callbackQuery, actionData);
	},

	async handleComposeCallback(c, chatId, callbackQuery, actionData) {

		const draft = await this.getDraft(c, chatId);

		if (!draft) {
			await this.answerCallback(c, callbackQuery.id, '草稿已过期');
			await this.sendText(c, chatId, '当前没有进行中的发信草稿，发送 /compose 或 /reply <邮件ID> 开始。');
			return;
		}

		if (actionData.action === 'cancel') {
			await this.clearDraft(c, chatId);
			await this.answerCallback(c, callbackQuery.id, '已取消');
			await this.sendText(c, chatId, '已取消当前发信草稿。');
			return;
		}

		if (actionData.action === 'page') {
			draft.step = 'sender';
			draft.page = Math.max(0, Number(actionData.value) || 0);
			await this.saveDraft(c, chatId, draft);
			await this.answerCallback(c, callbackQuery.id);
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		if (actionData.action === 'sender') {
			await this.answerCallback(c, callbackQuery.id, '已选择发件箱');
			await this.selectComposeSender(c, chatId, draft, actionData.value);
			return;
		}

		if (actionData.action === 'edit') {
			if (!COMPOSE_EDITABLE_STEPS.includes(actionData.value)) {
				await this.answerCallback(c, callbackQuery.id);
				return;
			}
			draft.step = actionData.value;
			if (draft.step === 'sender') {
				draft.page = 0;
			}
			await this.saveDraft(c, chatId, draft);
			await this.answerCallback(c, callbackQuery.id);
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		if (actionData.action === 'send') {
			await this.answerCallback(c, callbackQuery.id, '正在发送');
			await this.sendComposeDraft(c, chatId, draft);
			return;
		}

		await this.answerCallback(c, callbackQuery.id);
	},

	async startComposeCommand(c, chatId) {
		const draft = this.emptyDraft('compose');
		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	async startReplyCommand(c, chatId, argsList) {

		const emailId = Number(argsList[0]);

		if (!emailId || Number.isNaN(emailId)) {
			await this.sendText(c, chatId, '用法: /reply 邮件ID');
			return;
		}

		const emailRow = await this.selectEmailFullById(c, emailId);

		if (!emailRow) {
			await this.sendText(c, chatId, `邮件 #${emailId} 不存在或不可访问。`);
			return;
		}

		if (!emailRow.sendEmail) {
			await this.sendText(c, chatId, `邮件 #${emailId} 缺少发件人，无法创建回复草稿。`);
			return;
		}

		const replyMeta = this.toReplyMeta(emailRow);
		const draft = this.emptyDraft('reply');

		draft.receiveEmail = [replyMeta.sendEmail];
		draft.subject = replySubject(replyMeta.subject);
		draft.sendType = emailRow.messageId ? 'reply' : '';
		draft.replyEmailId = replyMeta.emailId;
		draft.replyMessageId = emailRow.messageId || '';
		draft.replyMeta = replyMeta;

		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	async cancelComposeCommand(c, chatId) {
		const draft = await this.getDraft(c, chatId);
		if (!draft) {
			await this.sendText(c, chatId, '当前没有进行中的发信草稿。');
			return;
		}
		await this.clearDraft(c, chatId);
		await this.sendText(c, chatId, '已取消当前发信草稿。');
	},

	async handleDraftText(c, chatId, rawText) {

		const draft = await this.getDraft(c, chatId);

		if (!draft) {
			await this.sendText(c, chatId, '当前没有进行中的发信草稿，发送 /compose 或 /reply <邮件ID> 开始。');
			return;
		}

		if (draft.step === 'sender') {
			await this.sendText(c, chatId, '请使用按钮选择发件邮箱。');
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		if (draft.step === 'confirm') {
			await this.sendText(c, chatId, '请使用确认区按钮发送或修改草稿。');
			await this.sendComposePreview(c, chatId, draft);
			return;
		}

		if (draft.step === 'recipient') {
			await this.applyRecipientInput(c, chatId, draft, rawText);
			return;
		}

		if (draft.step === 'subject') {
			await this.applySubjectInput(c, chatId, draft, rawText);
			return;
		}

		if (draft.step === 'body') {
			await this.applyBodyInput(c, chatId, draft, rawText);
			return;
		}
	},

	async applyRecipientInput(c, chatId, draft, rawText) {
		const { valid, invalid } = parseRecipientInput(rawText);

		if (valid.length === 0) {
			await this.sendText(c, chatId, '收件人不能为空，请输入有效邮箱。多个收件人可用逗号、空格或换行分隔。');
			return;
		}

		if (invalid.length > 0) {
			await this.sendText(c, chatId, `以下收件人格式不正确: ${invalid.join(', ')}`);
			return;
		}

		draft.receiveEmail = valid;
		draft.step = this.nextStepAfterRecipient(draft);
		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	async applySubjectInput(c, chatId, draft, rawText) {
		const subject = normalizeText(rawText);

		if (!subject) {
			await this.sendText(c, chatId, '主题不能为空，请重新输入。');
			return;
		}

		draft.subject = subject;
		draft.step = this.nextStepAfterSubject(draft);
		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	async applyBodyInput(c, chatId, draft, rawText) {
		const bodyText = normalizeText(rawText);

		if (!bodyText) {
			await this.sendText(c, chatId, '正文不能为空，请重新输入。');
			return;
		}

		draft.bodyText = bodyText;
		draft.step = 'confirm';
		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	async showComposeStep(c, chatId, draft) {

		if (draft.step === 'sender') {
			await this.showSenderSelector(c, chatId, draft);
			return;
		}

		if (draft.step === 'recipient') {
			await this.sendText(c, chatId, '请输入收件人邮箱。多个收件人可用逗号、空格或换行分隔。发送 /cancel 取消。');
			return;
		}

		if (draft.step === 'subject') {
			await this.sendText(c, chatId, '请输入邮件主题。发送 /cancel 取消。');
			return;
		}

		if (draft.step === 'body') {
			let text = draft.mode === 'reply'
				? '请输入回复正文，支持多行纯文本。发送 /cancel 取消。'
				: '请输入邮件正文，支持多行纯文本。发送 /cancel 取消。';

			if (draft.mode === 'reply' && !draft.replyMessageId) {
				text += '\n注意: 原邮件缺少 messageId，将按普通邮件发送。';
			}

			await this.sendText(c, chatId, text);
			return;
		}

		if (draft.step === 'confirm') {
			await this.sendComposePreview(c, chatId, draft);
		}
	},

	async showSenderSelector(c, chatId, draft) {

		let accounts = [];

		try {
			({ accounts } = await this.resolveAdminContext(c));
		} catch (e) {
			await this.clearDraft(c, chatId);
			await this.sendText(c, chatId, `无法加载管理员发件邮箱: ${this.shortText(e?.message || 'Unknown error', 200)}`);
			return;
		}

		if (accounts.length === 0) {
			await this.clearDraft(c, chatId);
			await this.sendText(c, chatId, '管理员没有可用发件邮箱，无法创建草稿。');
			return;
		}

		if (accounts.length === 1) {
			await this.selectComposeSender(c, chatId, draft, accounts[0].accountId);
			return;
		}

		const totalPages = Math.max(1, Math.ceil(accounts.length / TELEGRAM_SENDER_PAGE_SIZE));
		draft.page = Math.min(Math.max(draft.page, 0), totalPages - 1);
		await this.saveDraft(c, chatId, draft);

		const title = draft.mode === 'reply'
			? `请选择发件邮箱（第 ${draft.page + 1}/${totalPages} 页），用于回复 #${draft.replyEmailId}。`
			: `请选择发件邮箱（第 ${draft.page + 1}/${totalPages} 页）。`;

		await this.sendMessage(c, chatId, title, {
			reply_markup: this.buildSenderKeyboard(accounts, draft.page)
		});
	},

	async selectComposeSender(c, chatId, draft, accountId) {
		let accounts = [];

		try {
			({ accounts } = await this.resolveAdminContext(c));
		} catch (e) {
			await this.sendText(c, chatId, `无法加载管理员发件邮箱: ${this.shortText(e?.message || 'Unknown error', 200)}`);
			return;
		}

		const selectedId = Number(accountId);
		const accountRow = accounts.find(item => item.accountId === selectedId);

		if (!accountRow) {
			draft.step = 'sender';
			await this.saveDraft(c, chatId, draft);
			await this.sendText(c, chatId, '发件邮箱无效，请重新选择。');
			await this.showSenderSelector(c, chatId, draft);
			return;
		}

		draft.accountId = accountRow.accountId;
		draft.step = this.nextStepAfterSender(draft);
		await this.saveDraft(c, chatId, draft);
		await this.showComposeStep(c, chatId, draft);
	},

	buildSenderKeyboard(accounts, page = 0) {
		const totalPages = Math.max(1, Math.ceil(accounts.length / TELEGRAM_SENDER_PAGE_SIZE));
		const safePage = Math.min(Math.max(page, 0), totalPages - 1);
		const begin = safePage * TELEGRAM_SENDER_PAGE_SIZE;
		const currentList = accounts.slice(begin, begin + TELEGRAM_SENDER_PAGE_SIZE);
		const inlineKeyboard = currentList.map(item => ([
			{
				text: this.shortText(item.name ? `${item.name} <${item.email}>` : item.email, 60),
				callback_data: `${COMPOSE_CALLBACK_PREFIX}|sender|${item.accountId}`
			}
		]));

		if (totalPages > 1) {
			const navRow = [];
			if (safePage > 0) {
				navRow.push({
					text: '上一页',
					callback_data: `${COMPOSE_CALLBACK_PREFIX}|page|${safePage - 1}`
				});
			}
			if (safePage < totalPages - 1) {
				navRow.push({
					text: '下一页',
					callback_data: `${COMPOSE_CALLBACK_PREFIX}|page|${safePage + 1}`
				});
			}
			if (navRow.length > 0) {
				inlineKeyboard.push(navRow);
			}
		}

		inlineKeyboard.push([
			{
				text: '取消',
				callback_data: `${COMPOSE_CALLBACK_PREFIX}|cancel`
			}
		]);

		return { inline_keyboard: inlineKeyboard };
	},

	buildConfirmKeyboard() {
		return {
			inline_keyboard: [
				[
					{ text: '发送', callback_data: `${COMPOSE_CALLBACK_PREFIX}|send` },
					{ text: '取消', callback_data: `${COMPOSE_CALLBACK_PREFIX}|cancel` }
				],
				[
					{ text: '改发件箱', callback_data: `${COMPOSE_CALLBACK_PREFIX}|edit|sender` },
					{ text: '改收件人', callback_data: `${COMPOSE_CALLBACK_PREFIX}|edit|recipient` }
				],
				[
					{ text: '改主题', callback_data: `${COMPOSE_CALLBACK_PREFIX}|edit|subject` },
					{ text: '改正文', callback_data: `${COMPOSE_CALLBACK_PREFIX}|edit|body` }
				]
			]
		};
	},

	async sendComposePreview(c, chatId, draft) {

		let selectedAccount = null;

		try {
			selectedAccount = await this.getSelectedAdminAccount(c, draft.accountId);
		} catch (e) {
			await this.sendText(c, chatId, `无法加载管理员发件邮箱: ${this.shortText(e?.message || 'Unknown error', 200)}`);
			return;
		}

		if (!selectedAccount) {
			draft.step = 'sender';
			await this.saveDraft(c, chatId, draft);
			await this.sendText(c, chatId, '发件邮箱不可用，请重新选择。');
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		let text =
			`发信预览\n` +
			`From: ${this.senderName(selectedAccount)} <${selectedAccount.email}>\n` +
			`To: ${draft.receiveEmail.join(', ')}\n` +
			`Subject: ${draft.subject}\n`;

		if (draft.mode === 'reply' && draft.replyMeta?.emailId) {
			text += `Reply To: #${draft.replyMeta.emailId} ${draft.replyMeta.sendEmail || '-'}\n`;
			if (!draft.replyMessageId) {
				text += `Note: 原邮件缺少 messageId，将按普通邮件发送\n`;
			}
		}

		text += `\n正文摘要:\n${this.shortText(draft.bodyText, 1200)}`;

		await this.sendMessage(c, chatId, text, {
			reply_markup: this.buildConfirmKeyboard()
		});
	},

	async sendComposeDraft(c, chatId, draft) {

		const missingStep = this.validateDraft(draft);

		if (missingStep) {
			draft.step = missingStep;
			await this.saveDraft(c, chatId, draft);
			await this.sendText(c, chatId, '草稿信息不完整，请继续填写。');
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		let adminContext = null;

		try {
			adminContext = await this.resolveAdminContext(c);
		} catch (e) {
			await this.sendText(c, chatId, `发送失败: ${this.shortText(e?.message || '管理员账号不存在', 200)}`);
			return;
		}

		const accountRow = adminContext.accounts.find(item => item.accountId === draft.accountId);

		if (!accountRow) {
			draft.step = 'sender';
			await this.saveDraft(c, chatId, draft);
			await this.sendText(c, chatId, '发件邮箱不可用，请重新选择。');
			await this.showComposeStep(c, chatId, draft);
			return;
		}

		try {
			const payload = this.buildSendPayload(draft, accountRow);
			const emailList = await emailService.send(c, payload, adminContext.user.userId);
			const sentEmail = emailList?.[0];

			await this.clearDraft(c, chatId);

			let text =
				`发送成功\n` +
				`From: ${this.senderName(accountRow)} <${accountRow.email}>\n` +
				`To: ${draft.receiveEmail.join(', ')}\n` +
				`Subject: ${draft.subject}`;

			if (sentEmail?.emailId) {
				text += `\n记录 ID: #${sentEmail.emailId}`;
			}

			await this.sendText(c, chatId, text);
		} catch (e) {
			draft.step = 'confirm';
			await this.saveDraft(c, chatId, draft);
			await this.sendText(c, chatId, `发送失败: ${this.shortText(e?.message || 'Unknown error', 240)}\n草稿已保留，可继续修改或重新发送。`);
			await this.sendComposePreview(c, chatId, draft);
		}
	},

	buildSendPayload(draft, accountRow) {
		let text = normalizeText(draft.bodyText);
		let content = textToHtml(text);
		let sendType = '';
		let emailId = 0;

		if (draft.mode === 'reply') {
			const replyPayload = buildReplyContent(text, draft.replyMeta || {});
			text = replyPayload.text;
			content = replyPayload.html;

			if (draft.replyMessageId) {
				sendType = 'reply';
				emailId = draft.replyEmailId;
			}
		}

		return {
			accountId: accountRow.accountId,
			name: accountRow.name || '',
			sendType,
			emailId,
			receiveEmail: draft.receiveEmail,
			text,
			content,
			subject: draft.subject,
			attachments: []
		};
	},

	validateDraft(draft) {
		if (!draft.accountId) {
			return 'sender';
		}
		if (!draft.receiveEmail || draft.receiveEmail.length === 0) {
			return 'recipient';
		}
		if (!draft.subject?.trim()) {
			return 'subject';
		}
		if (!draft.bodyText?.trim()) {
			return 'body';
		}
		return '';
	},

	nextStepAfterSender(draft) {
		if (draft.bodyText) {
			return 'confirm';
		}
		if (draft.mode === 'reply') {
			return 'body';
		}
		if (!draft.receiveEmail.length) {
			return 'recipient';
		}
		if (!draft.subject) {
			return 'subject';
		}
		return 'body';
	},

	nextStepAfterRecipient(draft) {
		if (draft.bodyText) {
			return 'confirm';
		}
		if (!draft.subject) {
			return 'subject';
		}
		return 'body';
	},

	nextStepAfterSubject(draft) {
		if (draft.bodyText) {
			return 'confirm';
		}
		return 'body';
	},

	async resolveAdminContext(c) {
		const user = await userService.selectByEmail(c, c.env.admin);
		if (!user) {
			throw new Error(`Admin user ${c.env.admin} not found`);
		}
		const accounts = await accountService.listByUserId(c, user.userId);
		return { user, accounts };
	},

	async getSelectedAdminAccount(c, accountId) {
		const { accounts } = await this.resolveAdminContext(c);
		return accounts.find(item => item.accountId === Number(accountId)) || null;
	},

	toReplyMeta(emailRow) {
		const rawText = emailRow.text ? emailRow.text : this.htmlToText(emailRow.content || '');
		return {
			emailId: emailRow.emailId,
			sendEmail: emailRow.sendEmail || '',
			name: emailRow.name || '',
			subject: emailRow.subject || '',
			createTime: emailRow.createTime || '',
			quoteText: this.shortText((rawText || '').trim() || '(无正文)', 6000),
			messageIdMissing: !emailRow.messageId
		};
	},

	emptyDraft(mode = 'compose') {
		return {
			mode,
			step: 'sender',
			accountId: 0,
			receiveEmail: [],
			subject: '',
			bodyText: '',
			sendType: '',
			replyEmailId: 0,
			replyMessageId: '',
			replyMeta: {},
			page: 0
		};
	},

	draftKey(chatId) {
		return `${KvConst.TG_COMPOSE_DRAFT}${chatId}`;
	},

	normalizeDraft(draft = {}) {
		return {
			mode: draft.mode === 'reply' ? 'reply' : 'compose',
			step: COMPOSE_STEPS.includes(draft.step) ? draft.step : 'sender',
			accountId: Number(draft.accountId) || 0,
			receiveEmail: Array.isArray(draft.receiveEmail) ? [...new Set(draft.receiveEmail.filter(Boolean))] : [],
			subject: typeof draft.subject === 'string' ? draft.subject : '',
			bodyText: typeof draft.bodyText === 'string' ? draft.bodyText : '',
			sendType: draft.sendType === 'reply' ? 'reply' : '',
			replyEmailId: Number(draft.replyEmailId) || 0,
			replyMessageId: typeof draft.replyMessageId === 'string' ? draft.replyMessageId : '',
			replyMeta: draft.replyMeta && typeof draft.replyMeta === 'object' ? draft.replyMeta : {},
			page: Math.max(0, Number(draft.page) || 0)
		};
	},

	async getDraft(c, chatId) {
		const rawDraft = await c.env.kv.get(this.draftKey(chatId), { type: 'json' });
		if (!rawDraft) {
			return null;
		}
		return this.normalizeDraft(rawDraft);
	},

	async saveDraft(c, chatId, draft) {
		await c.env.kv.put(this.draftKey(chatId), JSON.stringify(this.normalizeDraft(draft)), {
			expirationTtl: TELEGRAM_DRAFT_TTL
		});
	},

	async clearDraft(c, chatId) {
		await c.env.kv.delete(this.draftKey(chatId));
	},

	async webhookInfo(c, params) {

		const { secret } = params;

		if (secret !== c.env.jwt_secret) {
			return {
				ok: false,
				message: 'secret mismatch'
			};
		}

		const { tgBotToken, customDomain, tgChatId } = await settingService.query(c);

		if (!tgBotToken) {
			return {
				ok: false,
				message: 'tgBotToken not configured'
			};
		}

		const baseUrl = customDomain ? domainUtils.toOssDomain(customDomain) : new URL(c.req.url).origin;
		const expectedUrl = `${baseUrl}/api/telegram/webhook/${c.env.jwt_secret}`;

		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/getWebhookInfo`);

			if (!res.ok) {
				return {
					ok: false,
					message: `getWebhookInfo failed: ${res.status}`,
					expectedUrl
				};
			}

			const data = await res.json();

			if (!data.ok) {
				return {
					ok: false,
					message: data.description || 'telegram api error',
					expectedUrl
				};
			}

			const info = data.result || {};

			return {
				ok: true,
				expectedUrl,
				currentUrl: info.url || '',
				matched: info.url === expectedUrl,
				pendingUpdateCount: info.pending_update_count || 0,
				lastErrorDate: info.last_error_date || null,
				lastErrorMessage: info.last_error_message || null,
				maxConnections: info.max_connections || null,
				ipAddress: info.ip_address || null,
				allowChatIds: tgChatId ? tgChatId.split(',').map(item => item.trim()).filter(Boolean) : [],
				checkedAt: new Date().toISOString()
			};
		} catch (e) {
			return {
				ok: false,
				message: e.message,
				expectedUrl
			};
		}

	},

	async getEmailContent(c, params) {

		const { token } = params;
		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied');
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain);
			}

			return emailTextTemplate(emailRow.text || '');
		}

		return emailTextTemplate('The email does not exist');
	},

	async sendHelp(c, chatId) {
		const text =
			`Cloud Mail Bot 命令:\n` +
			`/start - 初始化并查看入口说明\n` +
			`/help - 查看命令说明\n` +
			`/compose - 新建发信草稿\n` +
			`/reply 邮件ID - 基于邮件 ID 创建回复草稿\n` +
			`/cancel - 取消当前发信草稿\n` +
			`/status - 查看系统状态\n` +
			`/stats [today] - 查看统计信息\n` +
			`/inbox [数量] - 查看最近收件（默认 10，最大 20）\n` +
			`/unread [数量] - 查看未读邮件（默认 10，最大 20）\n` +
			`/search 关键词 - 按发件人/收件人/主题搜索\n` +
			`/mail 邮件ID - 查看指定邮件详情\n` +
			`/mailraw 邮件ID - 查看邮件文本摘要\n` +
			`/roles - 查看角色ID列表\n` +
			`/users [关键词] - 查询用户（不填则返回全部）\n` +
			`/user 用户ID - 查看用户详情\n` +
			`/adduser 邮箱 角色ID - 自动随机密码添加用户\n` +
			`/adduser 邮箱 密码 角色ID - 指定密码添加用户`;
		await this.sendText(c, chatId, text);
	},

	async sendStart(c, chatId) {
		const text =
			`欢迎使用 Cloud Mail Bot。\n` +
			`当前仅支持管理员 chat_id 命令。\n` +
			`发送 /compose 开始发信，发送 /help 查看完整命令。`;
		await this.sendText(c, chatId, text);
	},

	async sendInbox(c, chatId, argsList) {

		const limit = this.parseLimit(argsList[0], 10, 20);
		const list = await this.selectReceiveList(c, null, limit);

		if (list.length === 0) {
			await this.sendText(c, chatId, '暂无收件邮件。');
			return;
		}

		const lineList = list.map(item => {
			const subject = this.shortText(item.subject || '(无主题)', 50);
			return `#${item.emailId} ${subject}\nFrom: ${item.sendEmail || '-'}\nTo: ${item.toEmail || '-'}\nTime: ${item.createTime || '-'}`;
		});

		await this.sendText(c, chatId, `最近 ${list.length} 封收件邮件:\n\n${lineList.join('\n\n')}`);
	},

	async searchInbox(c, chatId, argsText) {

		const keyword = (argsText || '').trim();

		if (!keyword) {
			await this.sendText(c, chatId, '用法: /search 关键词');
			return;
		}

		const list = await this.selectReceiveList(c, keyword, 10);

		if (list.length === 0) {
			await this.sendText(c, chatId, `没有找到关键词 "${this.shortText(keyword, 50)}" 的邮件。`);
			return;
		}

		const lineList = list.map(item => {
			const subject = this.shortText(item.subject || '(无主题)', 50);
			return `#${item.emailId} ${subject}\nFrom: ${item.sendEmail || '-'}\nTo: ${item.toEmail || '-'}\nTime: ${item.createTime || '-'}`;
		});

		await this.sendText(c, chatId, `搜索 "${this.shortText(keyword, 50)}" 命中 ${list.length} 封:\n\n${lineList.join('\n\n')}`);
	},

	async showMail(c, chatId, argsList) {

		const emailId = Number(argsList[0]);

		if (!emailId || Number.isNaN(emailId)) {
			await this.sendText(c, chatId, '用法: /mail 邮件ID');
			return;
		}

		const emailRow = await this.selectEmailById(c, emailId);

		if (!emailRow) {
			await this.sendText(c, chatId, `邮件 #${emailId} 不存在或不可访问。`);
			return;
		}

		const { customDomain } = await settingService.query(c);
		const baseUrl = customDomain ? domainUtils.toOssDomain(customDomain) : new URL(c.req.url).origin;
		const token = await jwtUtils.generateToken(c, { emailId }, 60 * 60);
		const detailUrl = `${baseUrl}/api/telegram/getEmail/${token}`;

		const text =
			`邮件 #${emailRow.emailId}\n` +
			`Subject: ${this.shortText(emailRow.subject || '(无主题)', 80)}\n` +
			`From: ${emailRow.sendEmail || '-'}\n` +
			`To: ${emailRow.toEmail || '-'}\n` +
			`Time: ${emailRow.createTime || '-'}\n` +
			`详情: ${detailUrl}`;

		await this.sendText(c, chatId, text);
	},

	async showMailRaw(c, chatId, argsList) {

		const emailId = Number(argsList[0]);

		if (!emailId || Number.isNaN(emailId)) {
			await this.sendText(c, chatId, '用法: /mailraw 邮件ID');
			return;
		}

		const emailRow = await this.selectEmailFullById(c, emailId);

		if (!emailRow) {
			await this.sendText(c, chatId, `邮件 #${emailId} 不存在或不可访问。`);
			return;
		}

		const rawText = emailRow.text ? emailRow.text : this.htmlToText(emailRow.content || '');
		const preview = this.shortText((rawText || '').trim() || '(无正文)', 1200);

		const text =
			`邮件 #${emailRow.emailId} 文本摘要\n` +
			`Subject: ${this.shortText(emailRow.subject || '(无主题)', 80)}\n` +
			`From: ${emailRow.sendEmail || '-'}\n` +
			`To: ${emailRow.toEmail || '-'}\n` +
			`Time: ${emailRow.createTime || '-'}\n\n` +
			`${preview}`;

		await this.sendText(c, chatId, text);
	},

	async sendUnread(c, chatId, argsList) {

		const limit = this.parseLimit(argsList[0], 10, 20);
		const list = await this.selectUnreadList(c, limit);

		if (list.length === 0) {
			await this.sendText(c, chatId, '暂无未读邮件。');
			return;
		}

		const lineList = list.map(item => {
			const subject = this.shortText(item.subject || '(无主题)', 50);
			return `#${item.emailId} ${subject}\nFrom: ${item.sendEmail || '-'}\nTo: ${item.toEmail || '-'}\nTime: ${item.createTime || '-'}`;
		});

		await this.sendText(c, chatId, `最近 ${list.length} 封未读邮件:\n\n${lineList.join('\n\n')}`);
	},

	async sendStatus(c, chatId) {

		const setting = await settingService.query(c);
		const storageType = await r2Service.storageType(c);
		const version = c.env.APP_VERSION || c.env.app_version || 'unknown';

		const text =
			`系统状态\n` +
			`Receive: ${setting.receive === 0 ? 'ON' : 'OFF'}\n` +
			`Send: ${setting.send === 0 ? 'ON' : 'OFF'}\n` +
			`Storage: ${storageType}\n` +
			`Version: ${version}`;

		await this.sendText(c, chatId, text);
	},

	async sendStats(c, chatId, argsList) {

		const mode = (argsList[0] || '').toLowerCase();

		if (mode === 'today') {

			const todayInfo = await this.todayStats(c);
			const text =
				`今日统计（UTC+8）\n` +
				`收件: ${todayInfo.receiveTotal}\n` +
				`发件: ${todayInfo.sendTotal}\n` +
				`新用户: ${todayInfo.userTotal}\n` +
				`新增邮箱: ${todayInfo.accountTotal}\n` +
				`今日发件计数(KV): ${todayInfo.daySendTotal}`;
			await this.sendText(c, chatId, text);
			return;
		}

		const numberCount = await analysisDao.numberCount(c);
		const daySendTotal = Number(await c.env.kv.get(KvConst.SEND_DAY_COUNT + dayjs().format('YYYY-MM-DD')) || 0);

		const text =
			`全局统计\n` +
			`收件总数: ${numberCount.receiveTotal}\n` +
			`发件总数: ${numberCount.sendTotal}\n` +
			`用户总数: ${numberCount.userTotal}\n` +
			`邮箱总数: ${numberCount.accountTotal}\n` +
			`今日发件计数(KV): ${daySendTotal}`;

		await this.sendText(c, chatId, text);
	},

	async sendRoles(c, chatId) {

		const roleList = await roleService.roleSelectUse(c);

		if (!roleList || roleList.length === 0) {
			await this.sendText(c, chatId, '暂无可用角色。');
			return;
		}

		const lines = roleList.map(item => `${item.roleId} - ${item.name}${item.isDefault ? ' (default)' : ''}`);
		await this.sendText(c, chatId, `角色列表:\n${lines.join('\n')}`);
	},

	async searchUsers(c, chatId, argsText) {

		const keyword = (argsText || '').trim();
		const userList = await this.listUsers(c, keyword);

		if (!userList || userList.length === 0) {
			if (keyword) {
				await this.sendText(c, chatId, `没有找到关键词 "${this.shortText(keyword, 50)}" 的用户。`);
			} else {
				await this.sendText(c, chatId, '暂无用户。');
			}
			return;
		}

		const lines = userList.map(item => {
			const status = item.status === 1 ? 'BAN' : 'NORMAL';
			return `#${item.userId} ${item.email} | roleId=${item.type} | status=${status}`;
		});

		const title = keyword
			? `命中 ${userList.length} 个用户（关键词: ${this.shortText(keyword, 50)}）:`
			: `用户列表（共 ${userList.length} 个）:`;

		await this.sendText(c, chatId, `${title}\n${lines.join('\n')}`);
	},

	async listUsers(c, keyword = '') {

		const size = 50;
		const all = [];
		let num = 1;

		while (true) {
			const data = await userService.list(c, {
				num,
				size,
				email: keyword,
				timeSort: 0,
				status: -1,
				isDel: 0
			});

			const list = data?.list || [];

			if (list.length === 0) {
				break;
			}

			all.push(...list);

			if (list.length < size) {
				break;
			}

			if (all.length >= 500) {
				break;
			}

			num++;
		}

		return all;
	},

	async showUser(c, chatId, argsList) {

		const userId = Number(argsList[0]);

		if (!userId || Number.isNaN(userId)) {
			await this.sendText(c, chatId, '用法: /user 用户ID');
			return;
		}

		const userRow = await userService.selectByIdIncludeDel(c, userId);

		if (!userRow) {
			await this.sendText(c, chatId, `用户 #${userId} 不存在。`);
			return;
		}

		const [roleRow, accountCount, receiveList, sendList] = await Promise.all([
			roleService.selectById(c, userRow.type),
			accountService.countUserAccount(c, userId),
			emailService.selectUserEmailCountList(c, [userId], emailConst.type.RECEIVE),
			emailService.selectUserEmailCountList(c, [userId], emailConst.type.SEND)
		]);

		const receiveTotal = receiveList[0]?.count || 0;
		const sendTotal = sendList[0]?.count || 0;
		const status = userRow.status === 1 ? 'BAN' : 'NORMAL';
		const delStatus = userRow.isDel === 1 ? 'DELETED' : 'ACTIVE';
		const roleName = roleRow ? `${roleRow.name}(${roleRow.roleId})` : `unknown(${userRow.type})`;

		const text =
			`用户 #${userRow.userId}\n` +
			`邮箱: ${userRow.email}\n` +
			`状态: ${status} / ${delStatus}\n` +
			`角色: ${roleName}\n` +
			`邮箱数: ${accountCount}\n` +
			`收件总数: ${receiveTotal}\n` +
			`发件总数: ${sendTotal}\n` +
			`发件次数计数: ${userRow.sendCount || 0}`;

		await this.sendText(c, chatId, text);
	},

	async addUserCommand(c, chatId, argsList) {

		let email = '';
		let password = '';
		let typeText = '';
		let autoPassword = false;

		if (argsList.length === 2) {
			email = argsList[0];
			typeText = argsList[1];
			password = cryptoUtils.genRandomPwd(10);
			autoPassword = true;
		} else if (argsList.length >= 3) {
			email = argsList[0];
			password = argsList[1];
			typeText = argsList[2];
		} else {
			await this.sendText(c, chatId, '用法: /adduser 邮箱 角色ID 或 /adduser 邮箱 密码 角色ID');
			return;
		}

		const type = Number(typeText);

		if (!Number.isInteger(type) || type <= 0) {
			await this.sendText(c, chatId, '角色ID必须是正整数。');
			return;
		}

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			await this.sendText(c, chatId, `角色ID ${type} 不存在。`);
			return;
		}

		try {
			await userService.add(c, { email, password, type });
			if (autoPassword) {
				await this.sendText(c, chatId, `添加用户成功: ${email} (roleId=${type})\n一次性密码: ${password}`);
			} else {
				await this.sendText(c, chatId, `添加用户成功: ${email} (roleId=${type})`);
			}
		} catch (e) {
			await this.sendText(c, chatId, `添加用户失败: ${this.shortText(e?.message || 'Unknown error', 200)}`);
		}
	},

	parseCommand(text) {

		const raw = (text || '').trim();

		if (!raw.startsWith('/')) {
			return null;
		}

		const [head, ...rest] = raw.split(/\s+/);
		const command = head.toLowerCase().split('@')[0];
		const argsText = rest.join(' ').trim();

		return {
			command,
			argsText,
			argsList: argsText ? argsText.split(/\s+/) : []
		};
	},

	parseLimit(limitStr, defValue = 10, maxValue = 20) {
		const value = Number(limitStr);
		if (!value || Number.isNaN(value)) {
			return defValue;
		}
		if (value < 1) {
			return 1;
		}
		return Math.min(value, maxValue);
	},

	shortText(text, maxLength = 60) {
		if (!text) {
			return '';
		}
		if (text.length <= maxLength) {
			return text;
		}
		return text.slice(0, maxLength - 1) + '…';
	},

	senderName(accountRow) {
		return accountRow?.name || accountRow?.email || '-';
	},

	limitTelegramText(text) {
		const content = text || '';
		if (content.length <= TELEGRAM_MESSAGE_LIMIT) {
			return content;
		}
		return content.slice(0, TELEGRAM_MESSAGE_LIMIT) + '\n...';
	},

	async sendText(c, chatId, text) {
		await this.sendMessage(c, chatId, text);
	},

	async sendMessage(c, chatId, text, extra = {}) {
		return this.telegramApi(c, 'sendMessage', {
			chat_id: chatId,
			text: this.limitTelegramText(text),
			...extra
		});
	},

	async answerCallback(c, callbackQueryId, text = '') {
		return this.telegramApi(c, 'answerCallbackQuery', {
			callback_query_id: callbackQueryId,
			...(text ? { text: this.shortText(text, 180) } : {})
		});
	},

	async telegramApi(c, method, payload) {

		const { tgBotToken } = await settingService.query(c);

		if (!tgBotToken) {
			return null;
		}

		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/${method}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				console.error(`Telegram ${method} failed status: ${res.status}, body: ${await res.text()}`);
				return null;
			}

			return res;
		} catch (e) {
			console.error(`Telegram ${method} error:`, e.message);
			return null;
		}
	},

	async allowChatIds(c) {
		const { tgChatId } = await settingService.query(c);
		if (!tgChatId) {
			return [];
		}
		return [...new Set(tgChatId.split(',').map(item => item.trim()).filter(Boolean))];
	},

	selectReceiveList(c, keyword, size = 10) {

		const conditions = [
			eq(email.type, emailConst.type.RECEIVE),
			eq(email.isDel, isDel.NORMAL),
			ne(email.status, emailConst.status.SAVING)
		];

		if (keyword) {
			const kw = `%${keyword}%`;
			conditions.push(
				or(
					sql`${email.subject} COLLATE NOCASE LIKE ${kw}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${kw}`,
					sql`${email.toEmail} COLLATE NOCASE LIKE ${kw}`,
					sql`${email.name} COLLATE NOCASE LIKE ${kw}`
				)
			);
		}

		return orm(c).select({
			emailId: email.emailId,
			sendEmail: email.sendEmail,
			toEmail: email.toEmail,
			subject: email.subject,
			createTime: email.createTime
		}).from(email)
			.where(and(...conditions))
			.orderBy(desc(email.emailId))
			.limit(size)
			.all();
	},

	selectEmailById(c, emailId) {
		return orm(c).select({
			emailId: email.emailId,
			sendEmail: email.sendEmail,
			toEmail: email.toEmail,
			subject: email.subject,
			createTime: email.createTime
		}).from(email)
			.where(
				and(
					eq(email.emailId, emailId),
					eq(email.isDel, isDel.NORMAL),
					ne(email.status, emailConst.status.SAVING)
				)
			)
			.get();
	},

	selectEmailFullById(c, emailId) {
		return orm(c).select({
			emailId: email.emailId,
			sendEmail: email.sendEmail,
			name: email.name,
			toEmail: email.toEmail,
			subject: email.subject,
			text: email.text,
			content: email.content,
			messageId: email.messageId,
			createTime: email.createTime
		}).from(email)
			.where(
				and(
					eq(email.emailId, emailId),
					eq(email.isDel, isDel.NORMAL),
					ne(email.status, emailConst.status.SAVING)
				)
			)
			.get();
	},

	selectUnreadList(c, size = 10) {
		return orm(c).select({
			emailId: email.emailId,
			sendEmail: email.sendEmail,
			toEmail: email.toEmail,
			subject: email.subject,
			createTime: email.createTime
		}).from(email)
			.where(
				and(
					eq(email.type, emailConst.type.RECEIVE),
					eq(email.unread, emailConst.unread.UNREAD),
					eq(email.isDel, isDel.NORMAL),
					ne(email.status, emailConst.status.SAVING)
				)
			)
			.orderBy(desc(email.emailId))
			.limit(size)
			.all();
	},

	async todayStats(c) {
		const [{ receiveTotal = 0, sendTotal = 0 } = {}] = await c.env.db.prepare(`
			SELECT
				SUM(CASE WHEN type = 0 THEN 1 ELSE 0 END) AS receiveTotal,
				SUM(CASE WHEN type = 1 THEN 1 ELSE 0 END) AS sendTotal
			FROM email
			WHERE DATE(create_time,'+8 hours') = DATE('now','+8 hours')
			  AND status != ${emailConst.status.SAVING}
		`).all().then(res => res.results || []);

		const [{ userTotal = 0 } = {}] = await c.env.db.prepare(`
			SELECT COUNT(*) AS userTotal
			FROM user
			WHERE DATE(create_time,'+8 hours') = DATE('now','+8 hours')
		`).all().then(res => res.results || []);

		const [{ accountTotal = 0 } = {}] = await c.env.db.prepare(`
			SELECT COUNT(*) AS accountTotal
			FROM account
			WHERE DATE(create_time,'+8 hours') = DATE('now','+8 hours')
		`).all().then(res => res.results || []);

		const daySendTotal = Number(await c.env.kv.get(KvConst.SEND_DAY_COUNT + dayjs().format('YYYY-MM-DD')) || 0);

		return {
			receiveTotal: Number(receiveTotal),
			sendTotal: Number(sendTotal),
			userTotal: Number(userTotal),
			accountTotal: Number(accountTotal),
			daySendTotal: Number(daySendTotal)
		};
	},

	htmlToText(content) {
		if (!content) {
			return '';
		}
		try {
			const { document } = parseHTML(content);
			return (document.body?.textContent || document.textContent || '').replace(/\s+/g, ' ').trim();
		} catch (e) {
			return content;
		}
	},

	async sendEmailToBot(c, emailRow) {

		const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		if (!tgBotToken || !tgChatId) {
			return;
		}

		const tgChatIds = tgChatId.split(',').map(item => item.trim()).filter(Boolean);
		const jwtToken = await jwtUtils.generateToken(c, { emailId: emailRow.emailId });
		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';

		await Promise.all(tgChatIds.map(async chatId => {
			await this.telegramApi(c, 'sendMessage', {
				chat_id: chatId,
				parse_mode: 'HTML',
				text: emailMsgTemplate(emailRow, tgMsgTo, tgMsgFrom, tgMsgText),
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: '查看',
								web_app: { url: webAppUrl }
							}
						]
					]
				}
			});
		}));

	}

};

export default telegramService;
