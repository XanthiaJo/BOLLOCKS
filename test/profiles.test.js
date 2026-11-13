// Connection page APIs: api_profiles (CRUD, activate, key secrecy),
// /api/models proxying, and mem_profiles with room assignment.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, mockLLM } from './helpers.js';

let s;
let llm;
before(async () => {
    s = await boot(tmp('data'));
    llm = await mockLLM();
    await s.login('creamms');
});
after(async () => { await s.stop(); await llm.close(); });

describe('api and memory profiles', () => {
    test('profile CRUD; first is auto-active; key never leaves the API', async () => {
        const p1 = (await s.post('profiles', { name: 'Mock', apiUrl: `${llm.url}/v1`, model: 'mock-7b', key: 'secret' })).json.id;
        const p2 = (await s.post('profiles', { name: 'Second', apiUrl: 'http://127.0.0.1:9/v1', model: 'm' })).json.id;
        let profiles = (await s.get('profiles')).json.profiles;
        assert.equal(profiles.find(p => p.id === p1).active, 1);
        assert.equal(profiles.find(p => p.id === p2).active, 0);
        assert.ok(profiles.every(p => !('key' in p) && p.has_key !== undefined), 'api key must not be exposed');

        assert.equal((await s.post('profiles/activate', { id: p2 })).status, 200);
        profiles = (await s.get('profiles')).json.profiles;
        assert.deepEqual(profiles.map(p => [p.id, p.active]), [[p1, 0], [p2, 1]]);
        assert.equal((await s.post('profiles/activate', { id: p1 })).status, 200);

        assert.equal((await s.post('profiles/update', { id: p2, name: 'Second2', apiUrl: 'http://x/v1', model: 'y' })).status, 200);
        assert.equal((await s.post('profiles/delete', { id: p2 })).status, 200);
    });

    test('/api/models proxies the connection; failures surface as 502', async () => {
        const r = await s.post('models', { apiUrl: `${llm.url}/v1` });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.models, ['mock-13b', 'mock-7b']);
        assert.equal((await s.post('models', {})).status, 400);
        assert.equal((await s.post('models', { apiUrl: 'http://127.0.0.1:9/v1' })).status, 502);
    });

    test('memprofile CRUD and room assignment', async () => {
        const mp = (await s.post('memprofiles', { name: 'TestMem', every: 5, budget: 400 })).json.id;
        assert.ok((await s.get('memprofiles')).json.profiles.some(p => p.mem_profiles_id_pk === mp));
        assert.equal((await s.post('memprofiles/update', { id: mp, name: 'TestMem2' })).status, 200);
        const room = (await s.post('rooms', { name: 'MP room' })).json.id;
        assert.equal((await s.post('room/memsettings', { room, memProfile: mp })).status, 200);
        assert.equal((await s.get('rooms')).json.rooms.find(r => r.id === room).mem_profiles_id_fk, mp);
        assert.equal((await s.post('memprofiles/delete', { id: mp })).status, 200);
        // Room re-pointed at another profile rather than left dangling.
        assert.notEqual((await s.get('rooms')).json.rooms.find(r => r.id === room).mem_profiles_id_fk, mp);
        await s.post('rooms/delete', { id: room });
    });
});
