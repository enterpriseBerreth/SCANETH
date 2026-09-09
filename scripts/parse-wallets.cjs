// Parse concatenated 0x addresses and validate checksums.
const raw = '0xc05ef5E1fD014267f66FA24B260f361Af7D791220x9748566962e3f6CaaC751D860614889794c2f0980xb51ff2F65B935142aab32aBEfa1C0E29A4161D310xdFB6c7AdB4D4e383e2d06A9F745513aCb8e7358e0xE353C12BB28dd8E3D98f63Ffe8118154d26d46A70x6318eB6235afDc7b4eEA60aFCce4961873f1C0f7';
const parts = raw.split('0x').filter(Boolean).map((s) => '0x' + s);
console.log('parsed count:', parts.length);
for (const p of parts) {
  const hex = p.slice(2);
  const validLen = hex.length === 40 && /^[0-9a-fA-F]+$/.test(hex);
  console.log(p, validLen ? 'LEN-OK' : 'INVALID(len=' + hex.length + ')');
}
console.log('\ncomma-joined:');
console.log(parts.join(','));
