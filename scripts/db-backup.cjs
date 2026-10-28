// Запускается внутри работающего контейнера (make backup). Копия через
// db.backup() целостна при живой записи и учитывает WAL: простое cp vpn.db
// без -wal/-shm дало бы базу без последних транзакций.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const src = path.join(process.cwd(), 'data', 'vpn.db');
const dest = path.join(process.cwd(), 'data', 'backup', 'vpn.db');

fs.mkdirSync(path.dirname(dest), { recursive: true });
// backup() не перезаписывает чужой хвост: остаток прошлой копии мог бы
// оказаться «целым» файлом с устаревшими данными при сбое на полпути.
fs.rmSync(dest, { force: true });

const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dest)
  .then(() => {
    db.close();
    console.log(`SQLite: копия записана в ${dest}`);
  })
  .catch((err) => {
    console.error(`SQLite: копия не удалась: ${err.message}`);
    process.exit(1);
  });
