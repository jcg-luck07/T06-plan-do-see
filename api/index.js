// Vercel이 실행하는 서버 함수 진입점. 모든 /api/* 요청이 여기로 옵니다 (vercel.json 참고).
module.exports = require('../lib/handler');
