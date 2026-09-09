/**
 * Master switch for Meta WhatsApp Flows — the tappable "Book now" and
 * "View offers" buttons.
 *
 * OFF means the bot is chat-only: greetings get a normal reply, and driver
 * bids arrive as the numbered chat list riders reply to with "1", "pay",
 * "cancel". The flow endpoint, screens and published Meta flows all stay in
 * place; nothing sends a button while this is false, whatever WHATSAPP_FLOW_ID
 * and WHATSAPP_OFFERS_FLOW_ID happen to hold.
 *
 * To bring the form back: flip this to true, make sure both flow ids are set
 * in .env, and redeploy.
 */
export const META_FLOWS_ENABLED = false;
