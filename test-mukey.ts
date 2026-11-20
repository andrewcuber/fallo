import { queryUsdaSda } from './lib/soil-profile-utils';
async function checkMukey() {
    const rows = await queryUsdaSda(`SELECT muname FROM mapunit WHERE mukey = '112353'`);
    console.log(rows);
}
checkMukey();