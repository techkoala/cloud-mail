import app from '../hono/hono';
import telegramService from '../service/telegram-service';
import result from '../model/result';

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	c.header('Cache-Control', 'public, max-age=604800, immutable');
	return c.html(content)
});

app.post('/telegram/webhook/:secret', async (c) => {
	await telegramService.webhook(c, c.req.param(), await c.req.json());
	return c.json(result.ok());
});

app.get('/telegram/webhookInfo/:secret', async (c) => {
	const data = await telegramService.webhookInfo(c, c.req.param());
	return c.json(result.ok(data));
});
