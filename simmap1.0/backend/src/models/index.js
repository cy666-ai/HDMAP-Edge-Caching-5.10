import { Sequelize } from 'sequelize'
import { defineRoadModel } from './Road.js'
import { defineVehicleModel } from './Vehicle.js'
import { defineTrajectoryModel } from './Trajectory.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, '../../data/simulation.db')

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: false,
  define: {
    freezeTableName: true
  }
})

// 定义模型
const Road = defineRoadModel(sequelize)
const Vehicle = defineVehicleModel(sequelize)
const Trajectory = defineTrajectoryModel(sequelize)

// 表关联
Vehicle.hasMany(Trajectory, { foreignKey: 'vehicleId' })
Trajectory.belongsTo(Vehicle, { foreignKey: 'vehicleId' })

async function initDatabase() {
  try {
    await sequelize.authenticate()
    console.log('[DB] SQLite 数据库连接成功')
    await sequelize.sync({ alter: true })
    console.log('[DB] 数据模型同步完成')
  } catch (err) {
    console.error('[DB] 数据库初始化失败:', err.message)
  }
}

export { sequelize, Road, Vehicle, Trajectory, initDatabase }
