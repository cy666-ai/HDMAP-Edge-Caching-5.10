import { DataTypes } from 'sequelize'

export function defineVehicleModel(sequelize) {
  return sequelize.define('Vehicle', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      comment: '车辆名称'
    },
    latitude: {
      type: DataTypes.FLOAT,
      defaultValue: 32.059,
      comment: '当前纬度'
    },
    longitude: {
      type: DataTypes.FLOAT,
      defaultValue: 118.769,
      comment: '当前经度'
    },
    speed: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
      comment: '当前速度 (km/h)'
    },
    heading: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
      comment: '行驶方向 (度)'
    },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'idle',
      comment: '状态: idle/running/paused'
    }
  })
}
