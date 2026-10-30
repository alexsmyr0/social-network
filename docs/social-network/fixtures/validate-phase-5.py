#!/usr/bin/env python3
"""Check B20 artifacts using an independent policy/state model; no runtime tests.

Usage: python3 docs/social-network/fixtures/validate-phase-5.py [pack.json]
The optional path supports consumers and mutation checks. No dependencies.
"""

import copy
import datetime as dt
import itertools
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/social-network'
MAX_ID = 9007199254740991
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
MESSAGES = {
    'NOT_FOUND': 'Not found', 'VALIDATION_ERROR': 'Validation failed',
    'MESSAGE_CONFLICT': 'Message retry differs from original',
    'STALE_EVENT_RESPONSE': 'Event response changed; refresh and retry',
    'STALE_MEMBERSHIP': 'Membership changed; refresh before acting',
    'UNAUTHORIZED': 'Unauthorized', 'BAD_REQUEST': 'Bad request', 'METHOD_NOT_ALLOWED': 'Method not allowed',
    'UNSUPPORTED_MEDIA_TYPE': 'Unsupported media type', 'PAYLOAD_TOO_LARGE': 'Payload too large',
    'ORIGIN_FORBIDDEN': 'Origin forbidden', 'CSRF_CHECK_FAILED': 'Csrf check failed',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def merge(base, patch):
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def active(s, uid):
    return bool(s['users'].get(str(uid), {}).get('active'))


def follow(s, a, b):
    return s['follows'].get(f'{a}:{b}') == 'accepted'


def can_send(s, a, b):
    return a != b and active(s, a) and active(s, b) and (follow(s, a, b) or follow(s, b, a))


def member(s, uid, gid):
    group = s['groups'].get(str(gid))
    if not active(s, uid) or not group or not active(s, group['creator_id']):
        return None
    return next((m for m in s['memberships'].values() if m['user_id'] == uid and m['group_id'] == gid), None)


def pair_messages(s, a, b):
    return sorted((m for m in s['dms'].values() if {m['sender_id'], m['recipient_id']} == {a, b}), key=lambda m: m['id'])


def history_allowed(s, a, b):
    return a != b and active(s, a) and active(s, b) and (can_send(s, a, b) or bool(pair_messages(s, a, b)))


def live(s, sender, recipient):
    return can_send(s, sender, recipient) and s['users'][str(recipient)]['online']


def name(s, uid):
    return s['users'][str(uid)]['display_name'] if active(s, uid) else 'Unavailable account'


def wire_message(s, message, group=False):
    result = {k: v for k, v in message.items() if k != 'membership_id'}
    result['sender_username'] = name(s, message['sender_id'])
    if group:
        result.pop('image_url', None)
    return result


def event_view(s, event, viewer):
    responses = []
    for key, r in s['responses'].items():
        eid, mid = map(int, key.split(':'))
        m = member(s, r['user_id'], event['group_id'])
        if eid == event['id'] and m and m['id'] == mid:
            responses.append(r)
    own = next((r for r in responses if r['user_id'] == viewer), None)
    return {k: v for k, v in event.items() if k != 'creator_id'} | {
        'creator': {'id': event['creator_id'], 'display_name': name(s, event['creator_id'])},
        'options': ['going', 'not_going'],
        'counts': {choice: sum(r['choice'] == choice for r in responses) for choice in ('going', 'not_going')},
        'viewer_response': {'choice': own['choice'], 'version': own['version']} if own else None,
    }


def unread(s, a, b=None, gid=None):
    if gid is not None:
        m = member(s, a, gid)
        if not m:
            return 0
        cursor = s['group_cursors'][str(m['id'])]
        return sum(msg['group_id'] == gid and msg['sender_id'] != a and msg['id'] > cursor for msg in s['messages'].values())
    if b is not None:
        if not history_allowed(s, a, b):
            return 0
        cursor = s['dm_cursors'].get(f'{a}:{b}', 0)
        return sum(m['recipient_id'] == a and m['id'] > cursor for m in pair_messages(s, a, b))
    return sum(unread(s, a, b=u['id']) for u in s['users'].values() if u['id'] != a)


def visible_notices(s, uid):
    return sorted((n for n in s['notices'].values() if n['recipient_id'] == uid and active(s, n['actor_id'])
                   and str(n['event_id']) in s['events'] and member(s, uid, s['events'][str(n['event_id'])]['group_id'])),
                  key=lambda n: -n['id'])


def clean_text(value, limit, field, required=True, multiline=True):
    if not isinstance(value, str):
        return None, 'REQUIRED' if value is None else 'INVALID_TEXT'
    text = value.replace('\r\n', '\n').strip()
    if required and not text:
        return None, 'REQUIRED' if field != 'body' else 'CONTENT_REQUIRED'
    if len(text) > limit:
        return None, 'TOO_LONG'
    if any((unicodedata.category(c) == 'Cc' and not (multiline and c in '\t\n')) or unicodedata.category(c) == 'Cs' for c in text):
        return None, 'INVALID_TEXT'
    return text, None


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', value):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(dt.timezone.utc)
        return f'{parsed.year:04}-{parsed.month:02}-{parsed.day:02}T{parsed.hour:02}:{parsed.minute:02}:{parsed.second:02}Z'
    except (ValueError, OverflowError):
        return None


class Model:
    def __init__(self, state, clock):
        self.s = copy.deepcopy(state)
        self.clock = clock
        self.signals = []

    def error(self, code='NOT_FOUND', status=404, fields=None):
        body = {'error': {'code': code, 'message': MESSAGES.get(code, code)}}
        if fields:
            body['error']['fields'] = fields
        return status, body

    def signal(self, kind, recipients, payload=None):
        item = {'type': kind, 'recipients': sorted(recipients)}
        if payload is not None:
            item['payload'] = payload
        self.signals.append(item)

    def allocate(self, kind):
        value = self.s['next_ids'][kind]
        require(value <= MAX_ID, f'{kind} ID overflow')
        self.s['next_ids'][kind] += 1
        return value

    def current(self, actor, gid, body=None):
        m = member(self.s, actor, gid)
        if not m:
            return None, self.error()
        if body is not None and body.get('membership_id') != m['id']:
            return None, self.error('STALE_MEMBERSHIP', 409)
        return m, None

    def group_people(self, gid):
        return sorted(m['user_id'] for m in self.s['memberships'].values() if m['group_id'] == gid and active(self.s, m['user_id']))

    def send(self, actor, target, body, group=False):
        s = self.s
        m = None
        if group:
            m, error = self.current(actor, target, body)
            if error:
                return error
        elif not can_send(s, actor, target):
            return self.error()
        table = s['messages'] if group else s['dms']
        target_key = 'group_id' if group else 'recipient_id'
        existing = next((msg for msg in table.values() if msg['sender_id'] == actor and msg['client_id'] == body['client_id']), None)
        if existing:
            same = existing[target_key] == target and existing['body'] == body['body']
            if group:
                same = same and existing['membership_id'] == m['id']
            else:
                same = same and existing.get('image_url') == body.get('image_url')
            return (200, {'data': wire_message(s, existing, group)}) if same else self.error('MESSAGE_CONFLICT', 409)
        media = None
        if body.get('image_url'):
            match = re.fullmatch(r'/api/v1/media/(\d+)', body['image_url'])
            media = s['media'].get(match[1]) if match else None
            if not media or media['uploader_id'] != actor or media['recipient_id'] != target or media['message_id'] is not None:
                return self.error()
        mid = self.allocate('message' if group else 'dm')
        msg = {'id': mid, target_key: target, 'sender_id': actor, 'body': body['body'], 'client_id': body['client_id'], 'created_at': self.clock}
        if group:
            msg['membership_id'] = m['id']
        else:
            if media:
                msg['image_url'] = body['image_url']
                media['message_id'] = mid
            s['dm_cursors'].setdefault(f'{actor}:{target}', 0)
            s['dm_cursors'].setdefault(f'{target}:{actor}', 0)
        table[str(mid)] = msg
        data = wire_message(s, msg, group)
        recipients = self.group_people(target) if group else sorted({actor, target} if live(s, actor, target) else {actor})
        self.signal('group.message' if group else 'dm.message', recipients, data)
        return 201, {'data': data}

    def create_event(self, actor, gid, body):
        _, error = self.current(actor, gid, body)
        if error:
            return error
        eid = self.allocate('event')
        event = {'id': eid, 'group_id': gid, 'creator_id': actor, 'created_at': self.clock,
                 **{k: body[k] for k in ('title', 'description', 'starts_at')}}
        self.s['events'][str(eid)] = event
        recipients = [uid for uid in self.group_people(gid) if uid != actor]
        for uid in recipients:
            nid = self.allocate('notice')
            self.s['notices'][str(nid)] = {'id': nid, 'recipient_id': uid, 'actor_id': actor, 'event_id': eid, 'is_read': False}
        if recipients:
            self.signal('notification.new', recipients)
        self.signal('social.invalidate', self.group_people(gid))
        return 201, {'data': event_view(self.s, event, actor)}

    def respond(self, actor, gid, eid, body):
        m, error = self.current(actor, gid, body)
        if error:
            return error
        event = self.s['events'].get(str(eid))
        if not event or event['group_id'] != gid:
            return self.error()
        key = f'{eid}:{m["id"]}'
        old = self.s['responses'].get(key)
        version = old['version'] if old else 0
        if body['expected_version'] != version:
            return self.error('STALE_EVENT_RESPONSE', 409)
        require(version < MAX_ID, 'Response version overflow')
        self.s['responses'][key] = {'user_id': actor, 'choice': body['choice'], 'version': version + 1}
        self.signal('social.invalidate', self.group_people(gid))
        return 200, {'data': event_view(self.s, event, actor)}

    def mark_read(self, actor, target, body, group=False):
        if group:
            m, error = self.current(actor, target, body)
            if error:
                return error
            messages = [msg for msg in self.s['messages'].values() if msg['group_id'] == target]
            cursors, key = self.s['group_cursors'], str(m['id'])
        else:
            if not history_allowed(self.s, actor, target):
                return self.error()
            messages = pair_messages(self.s, actor, target)
            cursors, key = self.s['dm_cursors'], f'{actor}:{target}'
        through = body['through_id']
        if through != 0 and through not in {msg['id'] for msg in messages}:
            return self.error('VALIDATION_ERROR', 400, {'through_id': 'INVALID_ID'})
        old = cursors.get(key, 0)
        cursors[key] = max(old, through)
        data = {'through_id': cursors[key], 'unread_count': unread(self.s, actor, gid=target) if group else unread(self.s, actor, b=target)}
        if old != cursors[key]:
            self.signal('chat.read', [actor], {'kind': 'group' if group else 'dm', 'target_id': target, **data})
        return 200, {'data': data}

    def media(self, actor, mid):
        media = self.s['media'].get(str(mid))
        allowed = media and (actor in (media['uploader_id'], media['recipient_id']) if media['message_id'] is not None else actor == media['uploader_id'])
        if not allowed:
            return self.error()
        return 200, {'data': {'bytes_fixture': 'dm-png', 'content_type': 'image/png'}}

    def history(self, actor, target, query, group=False):
        if group:
            if not member(self.s, actor, target):
                return self.error()
            messages = sorted((m for m in self.s['messages'].values() if m['group_id'] == target), key=lambda m: m['id'])
        else:
            if not history_allowed(self.s, actor, target):
                return self.error()
            messages = pair_messages(self.s, actor, target)
        before, limit = int(query.get('before_id', MAX_ID + 1)), int(query.get('limit', 10))
        eligible = [m for m in messages if m['id'] < before]
        page = eligible[-limit:]
        more = len(eligible) > limit
        return 200, {'data': {'messages': [wire_message(self.s, m, group) for m in page],
                              'has_more': more, 'next_before_id': page[0]['id'] if more else None}}

    def page(self, items, query):
        page, size = int(query.get('page', 1)), int(query.get('per_page', 20))
        total = len(items)
        return 200, {'data': items[(page - 1) * size:page * size],
                     'meta': {'pagination': {'page': page, 'per_page': size, 'total': total, 'total_pages': (total + size - 1) // size}}}

    def roster(self, actor, query):
        entries = []
        for user in self.s['users'].values():
            uid = user['id']
            if not history_allowed(self.s, actor, uid):
                continue
            messages = pair_messages(self.s, actor, uid)
            last = messages[-1] if messages else None
            row = {'user_id': uid, 'username': name(self.s, uid), 'last_message_at': last['created_at'] if last else None,
                   'last_message_preview': (last['body'][:200] or '[image]') if last else None,
                   'last_sender_id': last['sender_id'] if last else None, 'can_send': can_send(self.s, actor, uid),
                   'unread_count': unread(self.s, actor, b=uid), 'read_through_id': self.s['dm_cursors'].get(f'{actor}:{uid}', 0)}
            if user['visibility'] == 'public' or follow(self.s, actor, uid):
                row['is_online'] = user['online']
            entries.append((row, last['id'] if last else None))
        entries.sort(key=lambda e: (0, -e[1]) if e[1] is not None else (1, e[0]['username'].lower(), e[0]['user_id']))
        return self.page([e[0] for e in entries], query)

    def rooms(self, actor, query):
        items = []
        for group in sorted(self.s['groups'].values(), key=lambda g: g['id']):
            m = member(self.s, actor, group['id'])
            if not m:
                continue
            messages = [msg for msg in self.s['messages'].values() if msg['group_id'] == group['id']]
            latest = max(messages, key=lambda msg: msg['id']) if messages else None
            items.append({'group': {'id': group['id'], 'title': group['title']}, 'membership_id': m['id'],
                          'last_message': wire_message(self.s, latest, True) if latest else None,
                          'read_through_id': self.s['group_cursors'][str(m['id'])], 'unread_count': unread(self.s, actor, gid=group['id'])})
        return self.page(items, query)

    def http(self, request):
        self.signals = []
        self.allow = None
        r = request
        method, actor = r['method'], r['actor']
        parsed = urlsplit(r['path'])
        path = parsed.path.removeprefix('/api/v1')
        methods = ['GET']
        if re.fullmatch(r'/(?:chats|groups)/\d+/messages|/groups/\d+/events', path):
            methods = ['GET', 'POST']
        elif re.fullmatch(r'/chats/\d+/images', path):
            methods = ['POST']
        elif path.endswith('/response') or re.fullmatch(r'/chats/\d+/read|/groups/\d+/messages/read', path):
            methods = ['PUT']
        elif path.startswith('/notifications/'):
            methods = ['PATCH']
        if method not in methods:
            self.allow = ', '.join(methods)
            return self.error('METHOD_NOT_ALLOWED', 405)
        query = parse_qs(parsed.query, keep_blank_values=True)
        write = method != 'GET'
        if write and r.get('origin', 'http://localhost:3000') != 'http://localhost:3000':
            return self.error('ORIGIN_FORBIDDEN', 403)
        if write and not r.get('xhr', True):
            return self.error('CSRF_CHECK_FAILED', 403)
        if not active(self.s, actor):
            return self.error('UNAUTHORIZED', 401)
        if any(not 1 <= int(segment) <= MAX_ID for segment in path.split('/') if segment.isdecimal()):
            return self.error('BAD_REQUEST', 400)
        upload = bool(re.fullmatch(r'/chats/\d+/images', path))
        if write and r.get('content_type', 'application/json') != ('multipart/form-data' if upload else 'application/json'):
            return self.error('UNSUPPORTED_MEDIA_TYPE', 415)
        if r.get('body_bytes', 0) > 16384:
            return self.error('PAYLOAD_TOO_LARGE', 413)
        if 'raw_json' in r:
            return self.error('BAD_REQUEST', 400)
        history_path = bool(re.fullmatch(r'/(?:chats|groups)/\d+/messages', path)) and method == 'GET'
        list_path = method == 'GET' and (path in ('/chats', '/group-chats', '/notifications') or bool(re.fullmatch(r'/groups/\d+/events(?:/\d+/responses)?', path)))
        allowed_query = {'before_id': MAX_ID, 'limit': 50} if history_path else {'page': 1000000, 'per_page': 50} if list_path else {}
        for key, values in query.items():
            if key not in allowed_query or len(values) != 1 or not re.fullmatch(r'[1-9]\d*', values[0]) or int(values[0]) > allowed_query[key]:
                return self.error('BAD_REQUEST', 400)
        query = {k: v[0] for k, v in query.items()}
        body = copy.deepcopy(r.get('json', {}))
        group = path.startswith('/groups/')
        is_send = method == 'POST' and path.endswith('/messages')
        is_create = method == 'POST' and path.endswith('/events')
        is_response = method == 'PUT' and path.endswith('/response')
        is_read = method == 'PUT' and path.endswith('/read')
        allowed = set()
        if is_send:
            allowed = {'client_id', 'body', 'membership_id'} if group else {'client_id', 'body', 'image_url'}
        elif is_create:
            allowed = {'membership_id', 'title', 'description', 'starts_at'}
        elif is_response:
            allowed = {'membership_id', 'choice', 'expected_version'}
        elif is_read:
            allowed = {'membership_id', 'through_id'} if group else {'through_id'}
        if set(body) - allowed:
            return self.error('BAD_REQUEST', 400)
        for key, value in body.items():
            if key in ('client_id', 'body', 'image_url', 'title', 'description', 'starts_at', 'choice'):
                if not isinstance(value, str):
                    return self.error('BAD_REQUEST', 400)
            elif type(value) is not int:
                return self.error('BAD_REQUEST', 400)
        fields = {}
        if is_send:
            if body.get('image_url') == '':
                body.pop('image_url')
            nonce = body.get('client_id')
            if nonce is None:
                fields['client_id'] = 'REQUIRED'
            elif not isinstance(nonce, str) or not UUID.fullmatch(nonce):
                fields['client_id'] = 'INVALID_UUID'
            text, error = clean_text(body.get('body'), 2000, 'body', required=group or not body.get('image_url'))
            if error:
                fields['body'] = error
            else:
                body['body'] = text
        if is_create:
            for key, limit in [('title', 100), ('description', 1000)]:
                text, error = clean_text(body.get(key), limit, key, multiline=key == 'description')
                if error:
                    fields[key] = error
                else:
                    body[key] = text
            time = instant(body.get('starts_at'))
            if time is None:
                fields['starts_at'] = 'INVALID_TIME'
            else:
                body['starts_at'] = time
        if is_response:
            if body.get('choice') not in ('going', 'not_going'):
                fields['choice'] = 'INVALID_CHOICE'
        ids = []
        if write and group:
            ids.append(('membership_id', False))
        if is_response:
            ids.append(('expected_version', True))
        if is_read:
            ids.append(('through_id', True))
        for key, zero in ids:
            value = body.get(key)
            if type(value) is not int or value < (0 if zero else 1) or value > MAX_ID:
                fields[key] = 'INVALID_ID'
        if fields:
            return self.error('VALIDATION_ERROR', 400, fields)
        if upload:
            parts = r.get('multipart', [])
            if len(parts) != 1 or set(parts[0]) != {'name', 'fixture_file'} or parts[0]['name'] != 'image':
                return self.error('BAD_REQUEST', 400)
            file = ROOT / parts[0]['fixture_file']
            require(file.is_file(), f'Missing upload fixture {file}')
            target = int(path.split('/')[2])
            if not can_send(self.s, actor, target):
                return self.error()
            mid = self.allocate('media')
            self.s['media'][str(mid)] = {'uploader_id': actor, 'recipient_id': target, 'message_id': None}
            return 200, {'data': {'image_url': f'/api/v1/media/{mid}'}}
        if path.startswith('/notifications'):
            visible = visible_notices(self.s, actor)
            if path == '/notifications':
                rows = []
                for n in visible:
                    event = self.s['events'][str(n['event_id'])]
                    group_data = self.s['groups'][str(event['group_id'])]
                    # Existing B10 relationship IDs/projections are replayed
                    # there; B20 pins the no-follow full/teaser event actors.
                    require(self.s['follows'].get(f'{actor}:{n["actor_id"]}', 'none') == 'none', 'Use B10 fixtures for relationship identities')
                    full = self.s['users'][str(n['actor_id'])]['visibility'] == 'public' or actor == n['actor_id']
                    actor_view = {'id': n['actor_id'], 'display_name': name(self.s, n['actor_id']), 'access': 'full' if full else 'teaser',
                                  'relationship': {'state': 'self' if actor == n['actor_id'] else 'none', 'follow_id': None}}
                    if full:
                        actor_view['avatar_url'] = None
                    rows.append({'id': n['id'], 'type': 'group_event', 'created_at': self.clock, 'is_read': n['is_read'],
                                 'actor': actor_view,
                                 'target': {'kind': 'group_event', 'event_id': event['id'], 'group': {'id': group_data['id'], 'title': group_data['title']}}, 'actions': []})
                status, response = self.page(rows, query)
                response['data'] = {'notifications': response['data'], 'unread_count': sum(not n['is_read'] for n in visible)}
                return status, response
            if path == '/notifications/read-all':
                changed = any(not n['is_read'] for n in visible)
                for n in visible:
                    n['is_read'] = True
                if changed:
                    self.signal('social.invalidate', [actor])
                return 204, None
            match = re.fullmatch(r'/notifications/(\d+)/read', path)
            notice = next((n for n in visible if match and n['id'] == int(match[1])), None)
            if not notice:
                return self.error()
            if not notice['is_read']:
                notice['is_read'] = True
                self.signal('social.invalidate', [actor])
            return 204, None
        if path == '/chats/unread':
            return 200, {'data': {'unread_count': unread(self.s, actor)}}
        if path == '/group-chats/unread':
            return 200, {'data': {'unread_count': sum(unread(self.s, actor, gid=g['id']) for g in self.s['groups'].values())}}
        if path == '/chats':
            return self.roster(actor, query)
        if path == '/group-chats':
            return self.rooms(actor, query)
        match = re.fullmatch(r'/media/(\d+)', path)
        if match:
            return self.media(actor, int(match[1]))
        match = re.fullmatch(r'/(chats|groups)/(\d+)/messages', path)
        if match:
            target = int(match[2])
            return self.send(actor, target, body, group) if is_send else self.history(actor, target, query, group)
        match = re.fullmatch(r'/(chats)/(\d+)/read|/(groups)/(\d+)/messages/read', path)
        if match:
            return self.mark_read(actor, int(match[4] or match[2]), body, group)
        match = re.fullmatch(r'/groups/(\d+)/events(?:/(\d+)(?:/(responses|response))?)?', path)
        if match:
            gid, eid, suffix = int(match[1]), int(match[2]) if match[2] else None, match[3]
            if not member(self.s, actor, gid):
                return self.error()
            if is_create:
                return self.create_event(actor, gid, body)
            if is_response:
                return self.respond(actor, gid, eid, body)
            events = sorted((e for e in self.s['events'].values() if e['group_id'] == gid), key=lambda e: (e['starts_at'], e['id']))
            if eid is None:
                return self.page([event_view(self.s, e, actor) for e in events], query)
            event = self.s['events'].get(str(eid))
            if not event or event['group_id'] != gid:
                return self.error()
            if suffix == 'responses':
                items = []
                for key, response in self.s['responses'].items():
                    rid, mid = map(int, key.split(':'))
                    m = member(self.s, response['user_id'], gid)
                    if rid == eid and m and m['id'] == mid:
                        items.append({'user': {'id': response['user_id'], 'display_name': name(self.s, response['user_id'])},
                                      'choice': response['choice'], 'version': response['version']})
                return self.page(sorted(items, key=lambda r: r['user']['id']), query)
            return 200, {'data': event_view(self.s, event, actor)}
        raise ValueError(f'Unmodeled route: {method} {path}')

    def observable(self, actor):
        s = self.s
        return {'dms_count': len(s['dms']), 'recipient_unread': unread(s, 2, b=1),
                'group_messages_count': len(s['messages']), 'events_count': len(s['events']),
                'notice_recipients_902': sorted(n['recipient_id'] for n in s['notices'].values() if n['event_id'] == 902),
                'media_701_message': s['media']['701']['message_id'],
                'notice_unread': sum(not n['is_read'] for n in visible_notices(s, actor)),
                'dm_cursor': s['dm_cursors'].get(f'{actor}:{3-actor}', 0) if actor in (1, 2) else 0}

    def action(self, a):
        self.signals = []
        op = a['op']
        s = self.s
        if op == 'follow':
            s['follows'][f'{a["from"]}:{a["to"]}'] = a['state']
            return {'status': 204}
        if op == 'online':
            s['users'][str(a['user'])]['online'] = a['value']
            return {'status': 204}
        if op == 'restart':
            self.s = json.loads(json.dumps(s))
            return {'status': 204}
        if op == 'remove':
            m = member(s, a['user'], a['group'])
            require(m is not None, 'Control removed nonmember')
            require(s['groups'][str(a['group'])]['creator_id'] != a['user'], 'Creator cannot leave')
            del s['memberships'][str(m['id'])]
            s['group_cursors'].pop(str(m['id']), None)
            return {'status': 204}
        if op == 'admit':
            require(member(s, a['user'], a['group']) is None, 'Control admitted member twice')
            mid = self.allocate('membership')
            s['memberships'][str(mid)] = {'id': mid, 'group_id': a['group'], 'user_id': a['user']}
            s['group_cursors'][str(mid)] = max((m['id'] for m in s['messages'].values() if m['group_id'] == a['group']), default=0)
            return {'status': 201, 'membership_id': mid}
        if op in ('notice_unread', 'notice_read_all'):
            notices = visible_notices(s, a['actor'])
            if op == 'notice_read_all':
                for n in notices:
                    n['is_read'] = True
                return {'status': 204}
            return {'status': 200, 'unread_count': sum(not n['is_read'] for n in notices)}
        actor, target = a.get('actor'), a.get('target')
        body = {k: v for k, v in a.items() if k not in ('op', 'actor', 'target', 'event_id')}
        if op in ('dm_send', 'group_send'):
            status, response = self.send(actor, target, body, group=op == 'group_send')
        elif op in ('dm_history', 'group_history'):
            status, response = self.history(actor, target, {}, group=op == 'group_history')
        elif op in ('dm_read', 'group_read'):
            status, response = self.mark_read(actor, target, body, group=op == 'group_read')
        elif op == 'event_create':
            status, response = self.create_event(actor, target, body)
        elif op == 'respond':
            status, response = self.respond(actor, target, a['event_id'], body)
        elif op == 'event_detail':
            event = s['events'].get(str(a['event_id']))
            status, response = (200, {'data': event_view(s, event, actor)}) if event and member(s, actor, target) else self.error()
        elif op == 'media':
            status, response = self.media(actor, target)
        elif op == 'dm_unread':
            status, response = 200, {'data': {'unread_count': unread(s, actor)}}
        elif op == 'group_unread':
            status, response = 200, {'data': {'unread_count': sum(unread(s, actor, gid=g['id']) for g in s['groups'].values())}}
        else:
            raise ValueError(f'Unmodeled action {op}')
        result = {'status': status}
        if status >= 400:
            result['code'] = response['error']['code']
        else:
            data = response.get('data', {})
            for key in ('id', 'through_id', 'unread_count'):
                if key in data:
                    result[key] = data[key]
            if 'messages' in data:
                result['ids'] = [m['id'] for m in data['messages']]
            if 'counts' in data:
                result.update(data['counts'])
                if data['viewer_response']:
                    result['version'] = data['viewer_response']['version']
            if op == 'event_create':
                result['notice_recipients'] = sorted(n['recipient_id'] for n in s['notices'].values() if n['event_id'] == data['id'])
        return result


def subset(actual, expected, label):
    require(isinstance(actual, dict), f'{label}: not object')
    for key, value in expected.items():
        require(key in actual and actual[key] == value, f'{label}.{key}: expected {str(value)[:200]}, got {str(actual.get(key))[:200]}')


def check_graph():
    tracker = (DOCS / 'ticket-tracker.md').read_text()
    rows = re.findall(r'^\| \[([ x!\-])\] \| \[SN-([AB]\d+)\].*$', tracker, re.M)
    require(len(rows) == len({ticket for _, ticket in rows}), 'Duplicate tracker ticket')
    summary = re.search(r'(\d+) tickets: (\d+) in A, (\d+) in B\. Done: (\d+)\. In progress: (\d+)\. Blocked: (\d+)\. Not started: (\d+)\.', tracker)
    require(summary is not None, 'Missing tracker totals')
    counts = [len(rows), sum(ticket.startswith('A') for _, ticket in rows), sum(ticket.startswith('B') for _, ticket in rows)]
    counts.extend(sum(status == expected for status, _ in rows) for expected in ('x', '-', '!', ' '))
    require(list(map(int, summary.groups())) == counts, 'Tracker totals differ from rows')
    tracks = '\n'.join((DOCS / f'track-{c}.md').read_text() for c in ('a', 'b'))
    sections = re.split(r'^## SN-', tracks, flags=re.M)[1:]
    graph, blocks = {}, {}
    for section in sections:
        ticket = section.split(' ', 1)[0]
        deps = re.search(r'^Depends on: (.*)$', section, re.M)
        reverse = re.search(r'^Blocks: (.*)$', section, re.M)
        require(deps and reverse, f'Missing graph metadata {ticket}')
        graph[ticket] = re.findall(r'SN-([AB]\d+)', deps[1])
        blocks[ticket] = re.findall(r'SN-([AB]\d+)', reverse[1])
    require(set(graph) == {ticket for _, ticket in rows}, 'Tracks/tracker tickets differ')
    for line in tracker.splitlines():
        if not re.match(r'^\| \[[ x!\-]\] \| \[SN-', line):
            continue
        cells = line.split('|')
        ticket = re.search(r'SN-([AB]\d+)', cells[2])[1]
        require(set(re.findall(r'SN-([AB]\d+)', cells[4])) == set(graph[ticket]), f'{ticket}: tracker dependency differs')
        require(set(re.findall(r'SN-([AB]\d+)', cells[5])) == set(blocks[ticket]), f'{ticket}: tracker reverse edge differs')
    for ticket, deps in graph.items():
        require(len(deps) == len(set(deps)), f'Duplicate edge {ticket}')
        require(set(blocks[ticket]) == {other for other in graph if ticket in graph[other]}, f'Reverse edges {ticket}')
        for dep in deps:
            require(dep in graph and dep != ticket, f'Unknown/self dependency {ticket}')
    seen, visiting = set(), set()
    def visit(ticket):
        require(ticket not in visiting, f'Cycle at {ticket}')
        if ticket in seen:
            return
        visiting.add(ticket)
        for dep in graph[ticket]:
            visit(dep)
        visiting.remove(ticket)
        seen.add(ticket)
    for ticket in graph:
        visit(ticket)
    return len(graph)


def check_links():
    files = [DOCS / name for name in ('events-chat-contract.md', 'phase-5-data-plan.md', 'phase-5-decisions.md', 'CONTEXT.md', 'ticket-tracker.md', 'track-b.md')]
    count = 0
    for path in files:
        for destination in re.findall(r'(?<!!)\[[^\]]*\]\(([^\s)]+)\)', path.read_text()):
            if '://' in destination or destination.startswith(('mailto:', 'app:')):
                continue
            part, _, anchor = unquote(destination).partition('#')
            target = (path.parent / part).resolve() if part else path
            require(target.exists(), f'{path.name}: missing link {destination}')
            if anchor and target.is_file():
                headings = re.findall(r'^#+\s+(.+)$', target.read_text(), re.M)
                slugs = [re.sub(r'[^\w\- ]', '', h.lower()).replace(' ', '-') for h in headings]
                require(anchor in slugs, f'{path.name}: missing anchor {destination}')
            count += 1
    return count


def check_pack(pack):
    require(pack['schema_version'] == 1, 'Unexpected pack schema')
    require(pack['review_status'] == 'owner-approved-2026-10-18', 'Owner approval record changed')
    require(pack['migration_order'] == [
        {'version': 8, 'ticket': 'SN-B21', 'tables': ['group_events', 'group_event_responses', 'notifications']},
        {'version': 9, 'ticket': 'SN-B22', 'tables': ['private_messages', 'dm_read_cursors']},
        {'version': 10, 'ticket': 'SN-B23', 'tables': ['group_messages', 'group_read_cursors']}], 'Migration mapping changed')
    clock, seed = pack['clock'], pack['state']
    expected_schemas = {
        'DM': {'id', 'sender_id', 'recipient_id', 'sender_username', 'body', 'created_at', 'client_id', 'image_url?'},
        'GroupMessage': {'id', 'group_id', 'sender_id', 'sender_username', 'body', 'created_at', 'client_id'},
        'Event': {'id', 'group_id', 'creator', 'title', 'description', 'starts_at', 'created_at', 'options', 'counts', 'viewer_response'},
    }
    require(set(pack['schemas']) == set(expected_schemas), 'Schema registry changed')
    for name, fields in expected_schemas.items():
        require(set(pack['schemas'][name]) == fields and len(pack['schemas'][name]) == len(fields), f'{name}: schema fields differ')
    cases = {case['id']: case for case in pack['http_cases']}
    require(len(cases) == len(pack['http_cases']), 'Duplicate HTTP ID')
    expected_dm = set(itertools.product(['none', 'pending', 'accepted'], ['none', 'pending', 'accepted'], ['public', 'private'], [False, True]))
    actual_dm = {(r['outgoing'], r['incoming'], r['recipient_visibility'], r['recipient_online']) for r in pack['dm_matrix']}
    require(len(pack['dm_matrix']) == len(expected_dm) and actual_dm == expected_dm, 'Incomplete DM matrix')
    for cell in pack['dm_matrix']:
        case = cases[cell['case_id']]
        s = merge(seed, case.get('given', {}))
        subset(cell, {'can_send': can_send(s, 1, 2), 'recipient_live': live(s, 1, 2),
                      'presence_visible': s['users']['2']['visibility'] == 'public' or follow(s, 1, 2)}, cell['case_id'])
        require(case['request']['actor'] == 1 and case['request']['path'] == '/api/v1/chats/2/messages', 'DM cell not backed by send')
        require(s['follows'].get('1:2') == cell['outgoing'] and s['follows'].get('2:1') == cell['incoming']
                and s['users']['2']['visibility'] == cell['recipient_visibility'] and s['users']['2']['online'] == cell['recipient_online'], 'DM matrix input/case mismatch')
    surfaces = {'event_list', 'event_detail', 'event_responses', 'event_create', 'event_respond', 'room_history', 'room_send', 'room_read'}
    expected_group = set(itertools.product(pack['roles'], surfaces))
    actual_group = {(r['role'], r['surface']) for r in pack['group_matrix']}
    require(actual_group == expected_group and len(actual_group) == len(pack['group_matrix']), 'Incomplete group matrix')
    for cell in pack['group_matrix']:
        case = cases[cell['case_id']]
        actor = pack['roles'][cell['role']]
        require(case['request']['actor'] == actor, 'Role/case actor mismatch')
        require(cell['allow'] == bool(member(seed, actor, 10)), 'Group policy mismatch')
        surface_paths = {
            'event_list': ('GET', '/api/v1/groups/10/events'), 'event_detail': ('GET', '/api/v1/groups/10/events/901'),
            'event_responses': ('GET', '/api/v1/groups/10/events/901/responses'), 'event_create': ('POST', '/api/v1/groups/10/events'),
            'event_respond': ('PUT', '/api/v1/groups/10/events/901/response'), 'room_history': ('GET', '/api/v1/groups/10/messages'),
            'room_send': ('POST', '/api/v1/groups/10/messages'), 'room_read': ('PUT', '/api/v1/groups/10/messages/read'),
        }
        require((case['request']['method'], case['request']['path']) == surface_paths[cell['surface']], 'Group surface/case mismatch')
    required_cases = {'dm-history', 'dm-history-limit', 'dm-history-next', 'dm-history-after-unfollow', 'dm-third-party',
                      'dm-empty-messageable', 'dm-self', 'dm-inactive-target', 'dm-unread', 'room-unread', 'room-unread-outsider',
                      'dm-read', 'dm-read-backwards', 'dm-read-forged', 'room-read-foreign', 'room-stale-generation',
                      'event-stale-version', 'event-wrong-group', 'room-history-limit', 'room-image-forbidden',
                      'dm-image-only', 'dm-image-wrong-uploader', 'dm-image-wrong-recipient', 'dm-committed-media-after-unfollow',
                      'dm-media-third-party', 'dm-staged-media-uploader', 'dm-staged-media-recipient', 'dm-roster',
                      'dm-roster-retained-private', 'dm-roster-outsider', 'room-summaries', 'room-summaries-outsider',
                      'dm-body-empty', 'dm-body-max', 'dm-body-too-long', 'group-body-empty', 'group-body-max', 'group-body-too-long',
                      'no-session', 'wrong-origin', 'missing-header', 'oversize', 'wrong-type', 'duplicate-json-key', 'trailing-json',
                      'upload-jpeg', 'upload-png', 'upload-gif', 'upload-unrelated', 'upload-extra-part', 'event-page-outside',
                      'event-choice-invalid', 'event-version-negative', 'dm-wrong-field-type', 'dm-unknown-field',
                      'unsafe-target-id', 'zero-target-id', 'notice-private-departed-actor', 'notice-inactive-actor'}
    required_cases.update(f'notice-{action}-{role}' for action in ('list', 'read', 'readall') for role in pack['roles'])
    require(required_cases <= cases.keys(), f'Missing boundary/path coverage: {required_cases - cases.keys()}')
    for cid, case in cases.items():
        initial = merge(seed, case.get('given', {}))
        model = Model(initial, clock)
        before = copy.deepcopy(model.s)
        status, body = model.http(case['request'])
        require(status == case['expect']['status'], f'{cid}: HTTP {status} != {case["expect"]["status"]}')
        require(body == case['expect']['body'], f'{cid}: response mismatch\nexpected {str(case["expect"]["body"])[:500]}\nactual {str(body)[:500]}')
        require(model.signals == case['expect']['signals'], f'{cid}: signal mismatch {model.signals}')
        require(model.allow == case['expect'].get('allow'), f'{cid}: Allow header mismatch')
        subset(model.observable(case['request']['actor']), case['expect']['state'], cid)
        if case['expect']['unchanged']:
            require(model.s == before, f'{cid}: unexpected mutation')
        for signal in model.signals:
            if signal['type'] in ('social.invalidate', 'notification.new'):
                require(set(signal) == {'type', 'recipients'}, f'{cid}: invalidation leaked payload')
    required_sequences = {'unfollow-refollow', 'nonce-retry', 'removal-readmission', 'events-notices', 'cursor-offline-recovery', 'event-response-version'}
    require({s['id'] for s in pack['sequences']} == required_sequences, 'Missing journey')
    for sequence in pack['sequences']:
        model = Model(seed, clock)
        for i, step in enumerate(sequence['steps']):
            before = copy.deepcopy(model.s)
            result = model.action(step['action'])
            subset(result, step['expect'], f'{sequence["id"]}/{i}')
            if result['status'] >= 400:
                require(model.s == before and not model.signals, f'{sequence["id"]}: rejected action mutated')
    require({r['id'] for r in pack['races']} == {'unfollow-send', 'remove-send', 'remove-response', 'duplicate-send', 'conflicting-send',
            'concurrent-response', 'read-send', 'remove-event-create'} and len(pack['races']) == 8, 'Missing/duplicate race coverage')
    for race in pack['races']:
        require({tuple(o['order']) for o in race['orders']} == {(0, 1), (1, 0)}, f'{race["id"]}: both orders required')
        for order in race['orders']:
            model = Model(seed, clock)
            results = [model.action(race['actions'][index]) for index in order['order']]
            require([r['status'] for r in results] == order['statuses'], f'{race["id"]}: order outcome differs')
            if race['id'] == 'duplicate-send':
                require(len(model.s['dms']) == len(seed['dms']) + 1, 'Duplicate committed twice')
            if race['id'] == 'read-send':
                require(unread(model.s, 2, b=1) == 1, 'Read swallowed newer message')
    for c in pack['delivery_cases']:
        s = merge(seed, c['given'])
        deliver = False
        if c['session_valid'] and active(s, c['viewer']):
            if c['type'] == 'dm.message':
                deliver = c['viewer'] == c['sender'] or live(s, c['sender'], c['viewer'])
            else:
                m = member(s, c['viewer'], c['target'])
                deliver = bool(m) and m['id'] == c['membership_id']
                if c['type'] in ('chat.read', 'chat.ack'):
                    deliver = deliver and c['viewer'] == c['sender'] and m['id'] == c['membership_id']
        require(deliver == c['deliver'], f'{c["id"]}: delivery predicate differs')
    for c in pack['media_cases']:
        if c.get('bytes', 0) > 10 * 1024 * 1024 or c.get('body_bytes', 0) > 12 * 1024 * 1024:
            status = 413
        elif c.get('extra_part'):
            status = 400
        elif (c['mime'] not in ('image/jpeg', 'image/png', 'image/gif') or c.get('corrupt')
              or c.get('decoded_mime', c['mime']) != c['mime']
              or not 1 <= c['width'] <= 8192 or not 1 <= c['height'] <= 8192 or c['width'] * c['height'] > 40000000
              or (c['mime'] == 'image/gif' and (not 1 <= c['frames'] <= 500 or c['width'] * c['height'] * c['frames'] > 128000000))):
            status = 422
        else:
            status = 200
        require(status == c['status'], f'{c["id"]}: image result differs')
    require({c['id'] for c in pack['socket_cases']} == {'dm-send', 'dm-duplicate', 'dm-conflict', 'group-send', 'group-duplicate',
            'group-conflict', 'unknown-frame', 'oversize-frame'}, 'Missing socket cases')
    for case in pack['socket_cases']:
        model = Model(merge(seed, case.get('given', {})), clock)
        frame = case['frame']
        if case.get('frame_bytes', 0) > 16384:
            result = {'close': 1009, 'fanout': []}
        elif frame['type'] not in ('dm.send', 'group.send'):
            result = {'error': {'type': 'chat.error', 'payload': {'code': 'INVALID_PAYLOAD', 'message': 'Invalid payload'}}, 'fanout': []}
        else:
            group = frame['type'] == 'group.send'
            payload = copy.deepcopy(frame['payload'])
            target = payload.pop('group_id' if group else 'recipient_id')
            status, body = model.http({'actor': case['actor'], 'method': 'POST',
                                       'path': f'/api/v1/{"groups" if group else "chats"}/{target}/messages', 'json': payload})
            if status >= 400:
                error = body['error'] | {'client_id': payload['client_id']}
                result = {'error': {'type': 'chat.error', 'payload': error}, 'fanout': model.signals}
            else:
                result = {'ack': {'type': 'chat.ack', 'payload': {'kind': 'group' if group else 'dm', 'target_id': target,
                           'client_id': payload['client_id'], 'message_id': body['data']['id'], 'duplicate': status == 200}}, 'fanout': model.signals}
        require(result == case['expect'], f'{case["id"]}: socket frame mismatch')
    for fixture, relative in pack['binary_fixtures'].items():
        file = ROOT / relative
        require(file.is_file() and file.read_bytes(), f'Missing binary fixture {fixture}')
    upgrade = pack['upgrade']
    require(upgrade['source_version'] == 7, 'Upgrade source changed')
    require(upgrade['expected_messages'] == [{**row, 'client_id': None} for row in upgrade['messages']], 'Upgrade changed old message data')
    require(upgrade['expected_message_sequence'] == upgrade['message_sequence'] >= max(m['id'] for m in upgrade['messages']), 'Message high-water lost')
    require(upgrade['expected_notice_sequence'] == upgrade['notice_sequence'] >= max(n['id'] for n in upgrade['notices_before']), 'Notice high-water lost')
    require(upgrade['notices_after'] == [{**row, 'event_id': None} for row in upgrade['notices_before']], 'Upgrade changed notice data')
    require(upgrade['media_before'] == upgrade['media_after'], 'Upgrade changed media association')
    cursors = {}
    for message in upgrade['messages']:
        a, b = message['sender_id'], message['recipient_id']
        for key in (f'{a}:{b}', f'{b}:{a}'):
            cursors[key] = max(cursors.get(key, 0), message['id'])
    require(cursors == upgrade['expected_dm_cursors'], 'DM bootstrap differs')
    require({str(m['id']): 0 for m in upgrade['memberships']} == upgrade['expected_group_cursors'], 'Room bootstrap differs')
    return len(cases)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DOCS / 'fixtures/phase-5-contract.json'
    pack = json.loads(path.read_text())
    count = check_pack(pack)
    graph = check_graph()
    links = check_links()
    print(f'B20 artifacts PASS: {count} HTTP cases, {len(pack["dm_matrix"])} DM cells, {len(pack["group_matrix"])} group cells, '
          f'{len(pack["sequences"])} journeys, {len(pack["races"])} two-order races, '
          f'{len(pack["delivery_cases"])} delivery cases, {len(pack["media_cases"])} image cases, '
          f'{len(pack["socket_cases"])} socket cases, upgrade mappings; {graph} tickets, {links} links. '
          'Owner-approved 2026-10-18; no application validation.')


if __name__ == '__main__':
    main()
