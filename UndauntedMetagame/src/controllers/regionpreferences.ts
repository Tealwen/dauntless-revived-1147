import { GetDb } from '../db';
import { HuntRegion, SetRegionReader } from './huntregion';

export function GetHuntRegion(userId: string): HuntRegion {
    const row = GetDb().$client.prepare('SELECT region FROM huntregions WHERE userId = ?').get(userId) as {region:string} | undefined;
    // A saved AUS choice outlives the AUS host. With the region off, those hunts could only ever be refused
    if (row?.region === 'aus') return process.env.AUS_REGION === '1' ? 'aus' : 'main';
    return row?.region === 'ger' || row?.region === 'us' ? row.region : 'main';
}
export function SaveHuntRegion(userId: string, region: HuntRegion) {
    GetDb().$client.prepare('INSERT INTO huntregions (userId, region) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET region = excluded.region').run(userId, region);
}
SetRegionReader(GetHuntRegion);
