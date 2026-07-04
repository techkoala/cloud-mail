import emailUtils from '../utils/email-utils'

const MODEL = {
	TEXT_FAST: '@cf/meta/llama-3.2-3b-instruct',
	TEXT_BALANCED: '@cf/meta/llama-3.1-8b-instruct',
	TEXT_POWERFUL: '@cf/meta/llama-3.1-8b-instruct',
	EMBEDDING: '@cf/baai/bge-base-en-v1.5'
}

const PROMPT_MAX_CHARS = 1200

function extractText(emailRow) {
	let text = emailUtils.htmlToText(emailRow.content) || ''
	if (!text) {
		text = (emailRow.text || '').trim()
	}
	return text.slice(0, PROMPT_MAX_CHARS)
}

const aiService = {

	MODEL,

	async run(c, model, prompt) {
		const ai = c.env.AI
		if (!ai) {
			console.error('AI binding not configured')
			return null
		}
		try {
			const result = await ai.run(model, { prompt, max_tokens: 256 })
			return result.response || result
		} catch (e) {
			console.error('AI run error:', e.message || e)
			return null
		}
	},

	async checkSpam(c, emailRow) {
		const text = extractText(emailRow)
		const subject = (emailRow.subject || '').trim()
		const sender = (emailRow.sendEmail || '').trim()

		const prompt = `You are a spam filter for a self-hosted email service. Analyze the following email and determine if it is spam.
Reply with ONLY one word: "spam" or "ham".

From: ${sender}
Subject: ${subject}
Body: ${text || '(empty)'}`

		const result = await this.run(c, MODEL.TEXT_FAST, prompt)
		if (!result) return false
		return String(result).toLowerCase().includes('spam')
	},

	async generatePushMsg(c, emailRow, mode) {
		const text = extractText(emailRow)
		const subject = (emailRow.subject || '').trim()
		const sender = (emailRow.sendEmail || '').trim()
		const name = (emailRow.name || '').trim()

		if (mode === 1) {
			const prompt = `Extract only the core message from this email. Remove signatures, disclaimers, quoted replies, and boilerplate. Keep it concise.

From: ${name} <${sender}>
Subject: ${subject}
Body: ${text || '(empty)'}

Core message:`

			const result = await this.run(c, MODEL.TEXT_FAST, prompt)
			if (!result) return null
			return { text: String(result).trim() }
		}

		if (mode === 2) {
			const prompt = `Summarize this email in a structured format:

From: ${name} <${sender}>
Subject: ${subject}
Body: ${text || '(empty)'}

Reply in this format (keep each field one line, use 'N/A' if not applicable):
SENDER: (who sent it, one line)
SUBJECT: (rewrite subject concisely)
SUMMARY: (1-2 sentence summary)
ACTION: (any action needed from recipient, or "none")`

			const result = await this.run(c, MODEL.TEXT_BALANCED, prompt)
			if (!result) return null
			return { text: String(result).trim() }
		}

		return null
	},

	async summarizeEmails(c, emailList) {
		if (!emailList || emailList.length === 0) return null

		const list = emailList.slice(0, 20).map(e => {
			const subj = (e.subject || '').trim() || '(no subject)'
			const from = (e.name || e.sendEmail || '').trim()
			return `- [${from}] ${subj}`
		}).join('\n')

		const prompt = `You are an email assistant. Here are today's received emails:

${list}

Total: ${emailList.length} emails.
Write a concise summary (in the same language as the email subjects). Include:
1. A one-line overview
2. Key topics/senders worth mentioning (2-4 bullet points)
3. Any emails that seem urgent/important

Keep it under 200 words.`

		const result = await this.run(c, MODEL.TEXT_BALANCED, prompt)
		if (!result) return null
		return String(result).trim()
	}

}

export default aiService
