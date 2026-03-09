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
import userService from './user-service';
import roleService from './role-service';
import accountService from './account-service';
import emailService from './email-service';
import analysisDao from '../dao/analysis-dao';
import r2Service from './r2-service';
import KvConst from '../const/kv-const';
import dayjs from 'dayjs';
import cryptoUtils from '../utils/crypto-utils';
import { parseHTML } from 'linkedom';

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
			`/status - 查看系统状态\n` +
			`/stats [today] - 查看统计信息\n` +
			`/inbox [数量] - 查看最近收件（默认 10，最大 20）\n` +
			`/unread [数量] - 查看未读邮件（默认 10，最大 20）\n` +
			`/search 关键词 - 按发件人/收件人/主题搜索\n` +
			`/mail 邮件ID - 查看指定邮件详情\n` +
			`/mailraw 邮件ID - 查看邮件文本摘要\n` +
			`/roles - 查看角色ID列表\n` +
			`/users 关键词 - 查询用户\n` +
			`/user 用户ID - 查看用户详情\n` +
			`/adduser 邮箱 角色ID - 自动随机密码添加用户\n` +
			`/adduser 邮箱 密码 角色ID - 指定密码添加用户`;
		await this.sendText(c, chatId, text);
	},

	async sendStart(c, chatId) {
		const text =
			`欢迎使用 Cloud Mail Bot。\n` +
			`当前仅支持管理员 chat_id 命令。\n` +
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

		if (!keyword) {
			await this.sendText(c, chatId, '用法: /users 关键词');
			return;
		}

		const data = await userService.list(c, {
			num: 1,
			size: 10,
			email: keyword,
			timeSort: 0,
			status: -1,
			isDel: 0
		});

		if (!data.list || data.list.length === 0) {
			await this.sendText(c, chatId, `没有找到关键词 "${this.shortText(keyword, 50)}" 的用户。`);
			return;
		}

		const lines = data.list.map(item => {
			const status = item.status === 1 ? 'BAN' : 'NORMAL';
			return `#${item.userId} ${item.email} | roleId=${item.type} | status=${status}`;
		});

		await this.sendText(c, chatId, `命中 ${data.list.length} 个用户:\n${lines.join('\n')}`);
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

	selectEmailFullById(c, emailId) {
		return orm(c).select({
			emailId: email.emailId,
			sendEmail: email.sendEmail,
			toEmail: email.toEmail,
			subject: email.subject,
			text: email.text,
			content: email.content,
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
