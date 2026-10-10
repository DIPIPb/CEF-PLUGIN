// Скачивает оригинальные иконки Rust (rustlabs) в папку ./icons
// Запуск (Node 18+):   node download-icons.js
// Дополнительно можно передать конфиг DIPBlock:   node download-icons.js DIPBlock.json
// Потом положите папку icons рядом с index.html на Vercel и задеплойте.
const fs = require('fs'), path = require('path');

const base = [
  // ресурсы
  'wood','stones','metal.ore','hq.metal.ore','sulfur.ore','sulfur','cloth','leather','fat.animal','scrap',
  'metal.fragments','metal.refined','lowgradefuel','charcoal','gunpowder','bone.fragments','plantfiber',
  'paper','explosives','crude.oil',
  // вайпблок (конфиг по умолчанию)
  'shotgun.waterpipe','pistol.revolver','flamethrower','military flamethrower','pistol.python','revolver.hc',
  'pistol.semiauto','shotgun.double','grenade.molotov','shotgun.m4','t1_smg','shotgun.pump','shotgun.spas12',
  'pistol.m92','pistol.prototype17','rifle.semiauto','coffeecan.helmet','roadsign.jacket','roadsign.kilt',
  'rifle.sks','smg.2','smg.thompson','smg.mp5','rifle.m39','metal.facemask','metal.plate.torso','rifle.ak',
  'rifle.lr300','rifle.bolt','rifle.l96','homingmissile.launcher','ballista.static','ballista.mounted',
  'batteringram','grenade.f1','heavy.plate.helmet','heavy.plate.jacket','heavy.plate.pants',
  'multiplegrenadelauncher','hmlmg','lmg.m249','minigun','catapult','grenade.beancan','surveycharge',
  'explosive.satchel','submarine.torpedo.straight','ammo.grenadelauncher.he','catapult.ammo.explosive',
  'rocket.launcher','ammo.rifle.explosive','explosive.timed','ammo.rocket.hv','ammo.rocket.fire',
  'ammo.rocket.basic','ammo.rocket.mlrs',
  // часто встречается в истории убийств
  'bow.hunting','bow.compound','crossbow','spear.wooden','spear.stone','hatchet','pickaxe','knife.combat',
  'longsword','machete','mace','bone.club','pistol.eoka','pistol.nailgun','smg.mp5','rifle.ak','m16a2','minicrossbow'
];

let names = new Set(base);
if (process.argv[2]) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  Object.values(cfg[Object.keys(cfg)[0]] || {}).forEach(a => Array.isArray(a) && a.forEach(n => names.add(n)));
}

const hosts = [
  n => `https://rustlabs.com/img/items180/${encodeURIComponent(n)}.png`,
  n => `https://wiki.rustclash.com/img/items180/${encodeURIComponent(n)}.png`,
  n => `https://www.rustedit.io/images/imagelibrary/${encodeURIComponent(n)}.png`
];

(async () => {
  const dir = path.join(__dirname, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  let ok = 0; const miss = [];
  for (const n of names) {
    const file = path.join(dir, n + '.png');
    if (fs.existsSync(file) && fs.statSync(file).size > 500) { ok++; continue; }
    let done = false;
    for (const h of hosts) {
      try {
        const r = await fetch(h(n), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length < 500) continue;
        fs.writeFileSync(file, b); done = true; break;
      } catch (e) {}
    }
    done ? ok++ : miss.push(n);
    process.stdout.write(done ? '.' : 'x');
  }
  console.log(`\nГотово: ${ok} иконок в ${dir}`);
  if (miss.length) console.log('Не нашлись:', miss.join(', '));
})();
