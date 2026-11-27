import { t as i18nText } from './i18n.js';
// The same date as TERMS_VERSION and PRIVACY_VERSION in src/account/terms.js (a unit test checks it)
const VERSION = '18 November 2026';
const EDITION =
    '<p class="legal-meta">' +
    ('<span>' +
        i18nText('Version dated {{v0}}. Effective from the date of publication.', { v0: i18nText(VERSION) }) +
        '</span></p>');

/** One record kept in the browser: its name, kind, what it's for and how long it stays. */
const record = (name, kind, purpose, term) =>
    `<li class="legal-record"><span class="legal-record-head"><code>${name}</code><span class="legal-chip">${kind}</span></span>` +
    `<span class="legal-record-purpose">${purpose}</span><span class="legal-record-term">${term}</span></li>`;
const CONTACT = '<a href="mailto:info@notfck.top">info@notfck.top</a>';

export const TERMS = {
    title: i18nText('Terms of Service'),
    body:
        EDITION +
        '\n        <h2>' +
        i18nText('About NotFckBot') +
        '</h2>\n        <p>' +
        i18nText(
            'NotFckBot helps you track films and TV series. These terms cover the Telegram bot, the Mini App, and the web panel. The bot is publicly available and the service is free. Access to the Mini App and web panel depends on your account permissions. Telegram’s'
        ) +
        ' ' +
        '<a href="https://telegram.org/tos" target="_blank" rel="noopener noreferrer">' +
        i18nText('Terms of Service') +
        '</a>' +
        ' ' +
        i18nText('also apply when you use the bot or Mini App.') +
        '</p>\n        <h2>' +
        i18nText('Accounts and group chats') +
        '</h2>\n        <p>' +
        i18nText(
            'To use the Mini App and web panel, you accept these terms and the Privacy Policy when you sign in. To sign in, the service uses the cookies described in the'
        ) +
        ' ' +
        '<button type="button" class="login-terms-link" data-action="login-privacy">' +
        i18nText('Privacy Policy') +
        '</button>.</p>\n        <p>' +
        i18nText(
            'Use your own account and keep your password, sign-in codes, and sign-in links private. If you notice an unfamiliar sign-in, review your active sessions and end any session you don’t recognize.'
        ) +
        '</p>\n        <p>' +
        i18nText(
            'Group chats share a subscription list and receive notifications in the group. Members can change subscriptions according to their permissions. A group’s administrators can change its NotFckBot settings.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Release dates and links') +
        '</h2>\n        <p>' +
        i18nText(
            'NotFckBot uses release dates, posters, and other title information from sources including TMDB, TVmaze, and Kinopoisk data. Release dates can change. Notifications depend on those sources, update checks, chat settings, and Telegram delivery. They may be delayed or missed. Release information is provided for reference. Availability varies by country and provider.'
        ) +
        '</p>\n        <p>' +
        i18nText(
            'Watch links open third-party sites with their own terms. Rights in posters, descriptions, and other materials belong to their respective rights holders.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Acceptable use') +
        '</h2>\n        <p>' +
        i18nText(
            'Spam, unauthorized access to accounts or private chats, bypassing access restrictions, and disrupting the service are prohibited. The operator may restrict access if these terms are breached or to protect the service, accounts, or chats.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Notifications, sign-out, and your data') +
        '</h2>\n        <p>' +
        i18nText(
            'To stop notifications, remove the subscriptions in that chat or block the bot in your private chat. Group admins can remove the bot from their group. Notifications for saved subscriptions may resume if the bot returns to that chat. To end your web session, sign out.'
        ) +
        '</p>\n        <p>' +
        i18nText('See the') +
        ' ' +
        '<button type="button" class="login-terms-link" data-action="login-privacy">' +
        i18nText('Privacy Policy') +
        '</button>' +
        ' ' +
        i18nText('for information on data processing and how to request deletion.') +
        '</p>\n        <h2>' +
        i18nText('Availability and changes') +
        '</h2>\n        <p>' +
        i18nText(
            'Features may become temporarily unavailable because of maintenance, technical issues, or changes to external services. Your mandatory rights under applicable law continue to apply. Updated terms are published with their effective date.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Contact') +
        '</h2>\n        <p>' +
        i18nText('For questions about these terms, the service, data processing, or materials, email {{v1}}.', {
            v1: CONTACT
        }) +
        '</p>'
};

export const PRIVACY = {
    title: i18nText('Privacy Policy'),
    body:
        EDITION +
        '\n        <p>' +
        i18nText(
            'This policy covers the NotFckBot Telegram bot, Mini App, and web panel. An individual operates the service. For questions or requests about your personal data, email {{v1}}.',
            { v1: CONTACT }
        ) +
        '</p>\n        <h2>' +
        i18nText('Data we process') +
        '</h2>\n        <p><strong>' +
        i18nText('Telegram and chats.') +
        '</strong>' +
        ' ' +
        i18nText(
            'When you use the bot or sign in through Telegram, we receive your Telegram account ID and profile name or username. For groups, we receive the chat ID and title and check membership and permissions as needed. The bot processes commands, button presses, and messages it receives to respond, run searches, and prevent spam.'
        ) +
        '</p>\n        <p><strong>' +
        i18nText('Subscriptions and activity.') +
        '</strong>' +
        ' ' +
        i18nText(
            'We keep the titles you follow, notification settings, recent activity, subscription and settings changes, and notification delivery records. The activity log may identify the member who made a group change. A search phrase sent to the bot may appear in technical logs with your Telegram ID.'
        ) +
        '</p>\n        <p><strong>' +
        i18nText('Sign-in and security.') +
        '</strong>' +
        ' ' +
        i18nText(
            'The panel and Mini App process sign-in confirmation data, session and device identifiers, IP address, browser and system information, activity times, and the approximate country and network. Country and network are looked up from the IP address using local databases. If you set a password, we store its hash.'
        ) +
        '</p>\n        <p><strong>Correspondence.</strong>' +
        ' ' +
        i18nText(
            'If you email us, we process your email address, message, and attachments to respond to your request.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Why we process data') +
        '</h2>\n        <p>' +
        i18nText(
            'We use data to search for titles, manage subscriptions and calendars, send notifications and summaries, provide access to accounts and shared lists, and compile chat statistics and recaps. Technical data helps us protect accounts, prevent spam, and diagnose issues. Correspondence data helps us answer questions and handle privacy requests.'
        ) +
        '</p>\n        <p>' +
        i18nText('Depending on the purpose, we process data to provide features you request under the') +
        ' ' +
        '<button type="button" class="login-terms-link" data-action="login-terms">' +
        i18nText('Terms of Service') +
        '</button>' +
        i18nText(
            ', to protect legitimate interests while respecting users’ rights, or to meet legal obligations. Where consent is required, we request it separately.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Who receives data') +
        '</h2>\n        <p><strong>Telegram.</strong>' +
        ' ' +
        i18nText(
            'Telegram sends interaction data to the bot and delivers replies, subscription notifications, and security messages. A sign-in alert sent to your private chat may include device information, approximate location, and IP address. Telegram’s'
        ) +
        ' ' +
        '<a href="https://telegram.org/privacy" target="_blank" rel="noopener noreferrer">' +
        i18nText('Privacy Policy') +
        '</a>' +
        ' ' +
        i18nText('applies to its services.') +
        '</p>\n        <p><strong>' +
        i18nText('Group members and administrators.') +
        '</strong>' +
        ' ' +
        i18nText(
            'Group members can see replies and notifications sent to their group. Members with access to a group list can see subscriptions and available change records. The operator and authorized admins can access data needed to manage the service and chats.'
        ) +
        '</p>\n        <p><strong>' +
        i18nText('Title information providers.') +
        '</strong>' +
        ' ' +
        i18nText(
            'We send search phrases to TMDB. To look up title details, posters, release dates, and links, we use names or IDs of films and series in requests to TMDB, TVmaze, Wikidata, and an API that provides Kinopoisk data.'
        ) +
        '</p>\n        <p><strong>' +
        i18nText('Google Fonts.') +
        '</strong>' +
        ' ' +
        i18nText(
            'The panel and Mini App load fonts from Google Fonts. The browser may send your IP address and technical request headers to Google. See'
        ) +
        ' ' +
        '<a href="https://developers.google.com/fonts/faq/privacy" target="_blank" rel="noopener noreferrer">' +
        i18nText('Google Fonts and privacy') +
        '</a>.</p>\n        <p><strong>' +
        i18nText('Service infrastructure.') +
        '</strong>' +
        ' ' +
        i18nText(
            'When you open the panel, a server proxy processes your IP address and forwards the request to the app. When you email us, the email service processes your address and message for delivery.'
        ) +
        '</p>\n        <p>' +
        i18nText(
            'When you follow an external link, the destination receives the browser request and applies its own rules. The operator may provide data to competent authorities when required by law.'
        ) +
        '</p>\n        <h2 id="privacy-cookies">' +
        i18nText('Cookies and browser settings') +
        '</h2>\n        <p>' +
        i18nText('To sign you in and protect your account, the panel stores these records in your browser:') +
        '</p>\n        <ul class="legal-records">\n            <li class="legal-records-head" aria-hidden="true"><span>' +
        i18nText('Name') +
        '</span><span>' +
        i18nText('Kind') +
        '</span><span>' +
        i18nText('Purpose') +
        '</span><span>' +
        i18nText('Kept') +
        '</span></li>\n            ' +
        record(
            'nfb_session',
            i18nText('Cookie · httpOnly'),
            i18nText('Signs you in to the panel.'),
            i18nText('1 year in the browser; the session on the server expires after 7 days without activity.')
        ) +
        '\n            ' +
        record(
            'nfb_device',
            i18nText('Cookie · httpOnly'),
            i18nText(
                'Recognizes this browser to protect sign-in: the “New sign-in” notice and limits for new devices.'
            ),
            i18nText('1 year.')
        ) +
        '\n            ' +
        record(
            i18nText('Interface settings'),
            'localStorage',
            i18nText('Things like list page size.'),
            i18nText('Until you clear the browser.')
        ) +
        '\n        </ul>\n        <p>' +
        i18nText(
            'These records are strictly necessary: without them you can’t sign in and your account isn’t protected, so we don’t ask for separate consent. Legal basis: performance of the contract (Terms of Service), Article 6(1)(5) of Federal Law 152-FZ.'
        ) +
        '</p>\n        <p>' +
        i18nText('Deleting these cookies signs you out. After that, this browser counts as a new device.') +
        '</p>\n        <p>' +
        i18nText('We don’t use analytics or advertising cookies. If that changes, we’ll ask you separately.') +
        '</p>\n        <h2>' +
        i18nText('Retention and security') +
        '</h2>\n        <p>' +
        i18nText(
            'We keep subscriptions, chat settings, and activity history to run the service and provide chat history and recaps. Removing or blocking the bot stops delivery to that chat. Chat data may be kept so it can be restored if the bot returns. You can request deletion of your personal data by email.'
        ) +
        '</p>\n        <p>' +
        i18nText(
            'Sign-in codes and one-time links are valid for five minutes. Expired sessions are removed during cleanup. Records of known devices are eligible for cleanup after 400 days of inactivity. Technical logs and backups may retain data until it is removed under applicable retention rules and law.'
        ) +
        '</p>\n        <p>' +
        i18nText(
            'We use HTTPS, access checks, sign-in rate limits, and hashed passwords and session tokens to protect data.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Your choices and rights') +
        '</h2>\n        <p>' +
        i18nText(
            'You can end sessions in your account and change or remove subscriptions you can access. To ask which data we process or to request correction, blocking, deletion, or an end to processing, email {{v5}}. Describe the request and include your Telegram username or ID if you know it. We may ask you to confirm that the request concerns your data.',
            { v5: CONTACT }
        ) +
        '</p>\n        <p>' +
        i18nText(
            'Requests are handled in accordance with applicable law. You can withdraw consent through the same address where processing relies on consent. Data that must be kept by law is handled within that requirement. You may also contact Roskomnadzor or seek relief in court.'
        ) +
        '</p>\n        <h2>' +
        i18nText('Changes to this policy') +
        '</h2>\n        <p>' +
        i18nText('An updated policy applies from its publication date.') +
        '</p>'
};
