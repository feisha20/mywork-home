export interface LunarInfo {
  solarDate: string
  yearName: string
  zodiac: string
  lunarMonthName: string
  lunarDayName: string
  solarTerm: string | null
  solarFestival: string | null
  lunarFestival: string | null
  displayTag: string
  tagType: 'festival' | 'solarTerm' | 'lunarMonth' | 'lunarDay'
  fullLunarString: string
}

const zodiacMap: Record<string, string> = {
  '子': '鼠', '丑': '牛', '寅': '虎', '卯': '兔',
  '辰': '龙', '巳': '蛇', '午': '马', '未': '羊',
  '申': '猴', '酉': '鸡', '戌': '狗', '亥': '猪'
}

const chineseDayNames: string[] = [
  '',
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
]

const sTermInfo = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
  263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
]

const solarTermNames = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
  '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
  '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
]

const solarFestivals: Record<string, string> = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '10-24': '程序员节',
  '12-24': '平安夜',
  '12-25': '圣诞节'
}

const lunarFestivals: Record<string, string> = {
  '正月-1': '春节',
  '正月-15': '元宵节',
  '二月-2': '龙头节',
  '五月-5': '端午节',
  '七月-7': '七夕节',
  '七月-15': '中元节',
  '八月-15': '中秋节',
  '九月-9': '重阳节',
  '十月-1': '寒衣节',
  '十月-15': '下元节',
  '腊月-8': '腊八节',
  '腊月-23': '北方小年',
  '腊月-24': '南方小年'
}

const shortFestivalNames: Record<string, string> = {
  '元旦': '元旦',
  '劳动节': '五一',
  '国庆节': '国庆',
  '春节': '春节',
  '元宵节': '元宵',
  '端午节': '端午',
  '中秋节': '中秋',
  '重阳节': '重阳',
  '除夕': '除夕',
  '清明节': '清明',
  '儿童节': '六一',
  '教师节': '教师节',
  '情人节': '情人节',
  '七夕节': '七夕'
}

const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})

function getSolarTermDay(year: number, n: number): number {
  const offDate = new Date((31556925974.7 * (year - 1900) + sTermInfo[n] * 60000) + Date.UTC(1900, 0, 6, 2, 5))
  return offDate.getUTCDate()
}

function parseLunarParts(date: Date) {
  const parts = lunarFormatter.formatToParts(date)
  const map: Record<string, string> = {}
  for (const part of parts) {
    map[part.type] = part.value
  }
  const yearName = map.yearName || ''
  const monthName = map.month || ''
  const dayNumber = parseInt(map.day || '1', 10)
  return { yearName, monthName, dayNumber }
}

export function getLunarDate(solarDate: string): LunarInfo {
  const [yearStr, monthStr, dayStr] = solarDate.split('-')
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)
  const day = parseInt(dayStr, 10)

  const date = new Date(`${solarDate}T12:00:00+08:00`)
  const { yearName, monthName, dayNumber } = parseLunarParts(date)

  const branch = yearName.slice(-1)
  const zodiac = zodiacMap[branch] || ''
  const lunarDayName = chineseDayNames[dayNumber] || `${dayNumber}`

  // 节气判断
  let solarTerm: string | null = null
  const termIdx1 = (month - 1) * 2
  const termIdx2 = termIdx1 + 1
  if (day === getSolarTermDay(year, termIdx1)) {
    solarTerm = solarTermNames[termIdx1]
  } else if (day === getSolarTermDay(year, termIdx2)) {
    solarTerm = solarTermNames[termIdx2]
  }

  // 公历节日
  const mdKey = `${monthStr.padStart(2, '0')}-${dayStr.padStart(2, '0')}`
  const solarFestival = solarFestivals[mdKey] || null

  // 农历节日
  const cleanMonth = monthName.replace(/闰/, '')
  const lKey = `${cleanMonth}-${dayNumber}`
  let lunarFestival = lunarFestivals[lKey] || null

  // 除夕判断：农历腊月且下一天为正月初一
  if (!lunarFestival && cleanMonth === '腊月' && dayNumber >= 29) {
    const nextDate = new Date(date.getTime() + 86400000)
    const nextParts = parseLunarParts(nextDate)
    if (nextParts.dayNumber === 1 || nextParts.monthName.includes('正月')) {
      lunarFestival = '除夕'
    }
  }

  // 展示优先级：农历节日 > 公历节日 > 节气 > 初一显示月份 > 农历日
  let displayTag = lunarDayName
  let tagType: LunarInfo['tagType'] = 'lunarDay'

  if (lunarFestival) {
    displayTag = shortFestivalNames[lunarFestival] || lunarFestival
    tagType = 'festival'
  } else if (solarFestival) {
    displayTag = shortFestivalNames[solarFestival] || solarFestival
    tagType = 'festival'
  } else if (solarTerm) {
    displayTag = solarTerm
    tagType = 'solarTerm'
  } else if (dayNumber === 1) {
    displayTag = monthName
    tagType = 'lunarMonth'
  }

  const fullLunarString = `${yearName}年【${zodiac}年】农历${monthName}${lunarDayName}`

  return {
    solarDate,
    yearName,
    zodiac,
    lunarMonthName: monthName,
    lunarDayName,
    solarTerm,
    solarFestival,
    lunarFestival,
    displayTag,
    tagType,
    fullLunarString
  }
}
