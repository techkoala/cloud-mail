import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import domainUtils from "../utils/domain-uitls";
import { emailConst, isDel } from '../const/entity-const';

const telegramService = {

	async webhook(c, params, body) {

		try {

			const { secret } = params;

			if (secret !== c.env.jwt_secret) {
				return;
			}

			const msg = body?.message || body?.edited_message;
			const chatId = String(msg?.chat?.id || '');
			const text = msg?.text?.trim?.() || '';

			if (!chatId || !text) {
				return;
			}

			const allowChatIds = await this.allowChatIds(c);

			if (!allowChatIds.includes(chatId)) {
				return;
			}

			const commandData = this.parseCommand(text);

			if (!commandData) {
				return;
			}

			const { command, argsText, argsList } = commandData;

			if (command === '/start') {
				await this.sendStart(c, chatId);
				return;
			}

			if (command === '/help') {
				await this.sendHelp(c, chatId);
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

			await this.sendText(c, chatId, '不支持的命令，请输入 /help 查看可用命令。');

		} catch (e) {
			console.error('Telegram webhook error:', e);
		}

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

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain)
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	async sendHelp(c, chatId) {
		const text =
			`Cloud Mail Bot 命令:\n` +
			`/start - 初始化并查看入口说明\n` +
			`/help - 查看命令说明\n` +
			`/inbox [数量] - 查看最近收件（默认 10，最大 20）\n` +
			`/search 关键词 - 按发件人/收件人/主题搜索\n` +
			`/mail 邮件ID - 查看指定邮件详情`;
		await this.sendText(c, chatId, text);
	},

	async sendStart(c, chatId) {
		const text =
			`欢迎使用 Cloud Mail Bot。\n` +
			`当前仅支持管理员 chat_id 只读命令。\n` +
			`发送 /help 查看可用命令。`;
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

	async sendText(c, chatId, text) {

		const { tgBotToken } = await settingService.query(c);

		if (!tgBotToken) {
			return;
		}

		let content = text || '';

		if (content.length > 3900) {
			content = content.slice(0, 3900) + '\n...';
		}

		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					chat_id: chatId,
					text: content
				})
			});

			if (!res.ok) {
				console.error(`Telegram sendMessage failed status: ${res.status}, body: ${await res.text()}`);
			}
		} catch (e) {
			console.error('Telegram sendMessage error:', e.message);
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

	async sendEmailToBot(c, email) {

		const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		const tgChatIds = tgChatId.split(',');

		const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'

		await Promise.all(tgChatIds.map(async chatId => {
			try {
				const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						parse_mode: 'HTML',
						text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
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
					})
				});
				if (!res.ok) {
					console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
				}
			} catch (e) {
				console.error(`转发 Telegram 失败:`, e.message);
			}
		}));

	}

}

export default telegramService
