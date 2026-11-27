import { t as i18nText } from './i18n.js';
/** Operations that affect everyone at once: update check, broadcast. */

import { $field } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal, setReturnTo, clearReturnTo, showConfirm, focusField } from './ui.js';
import { setSelectValue } from './select.js';
import { BROADCAST_AUDIENCE_LABELS } from './format.js';

export function triggerCheck() {
    closeModal('actions-modal');
    setReturnTo(() => openModal('actions-modal'));
    showConfirm({
        title: i18nText('Run update check?'),
        text: i18nText('Check for updates now and send any new notifications to subscribed chats.'),
        confirmLabel: i18nText('Run check'),
        cancelLabel: i18nText('Cancel'),
        onConfirm: async () => {
            try {
                await api('/trigger-check', { method: 'POST' });
                toast(i18nText('Update check triggered'), 'success');
            } catch (e) {
                toast(i18nText('Failed to trigger:') + ' ' + e.message, 'error');
            }
        }
    });
}

export function openBroadcastModal() {
    closeModal('actions-modal');
    setReturnTo(() => openModal('actions-modal'));
    $field('broadcast-msg').value = '';
    setSelectValue('broadcast-target', 'all');
    openModal('broadcast-modal');
    focusField($field('broadcast-msg'));
}

export function sendBroadcast() {
    const message = $field('broadcast-msg').value.trim();
    if (!message) return toast(i18nText('Enter a message first'), 'warning');

    const target = $field('broadcast-target').value;

    showConfirm({
        title: i18nText('📢 Send broadcast?'),
        text: i18nText('This sends the message to {{v0}}. Delivery cannot be undone or recalled.', {
            v0: BROADCAST_AUDIENCE_LABELS[target]
        }),
        confirmLabel: i18nText('Yes, send'),
        cancelLabel: i18nText('No, cancel'),
        onConfirm: async () => {
            const btn = $field('send-broadcast');
            btn.disabled = true;
            btn.innerText = i18nText('Sending...');

            try {
                const res = await api('/broadcast', { method: 'POST', body: { message, target } });
                const failed = res.failCount ? i18nText(', {{v0}} failed', { v0: res.failCount }) : '';
                const left = res.leftCount ? i18nText(', {{v0}} left the bot (skipped)', { v0: res.leftCount }) : '';
                toast(
                    i18nText('Delivered to {{v0}} chats{{v1}}{{v2}}', { v0: res.successCount, v1: failed, v2: left }),
                    res.failCount ? 'warning' : 'success'
                );
                clearReturnTo();
                closeModal('broadcast-modal');
                $field('broadcast-msg').value = '';
            } catch (e) {
                toast(i18nText('Broadcast failed:') + ' ' + e.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = i18nText('Send Broadcast');
            }
        }
    });
}
