import { DataTypes } from 'sequelize'

export function defineRoadModel(sequelize) {
  return sequelize.define('Road', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '道路名称'
    },
    // 道路几何数据（GeoJSON格式）
    geometry: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '道路几何坐标数据(GeoJSON)'
    },
    roadType: {
      type: DataTypes.STRING(50),
      defaultValue: 'highway',
      comment: '道路类型'
    },
    speedLimit: {
      type: DataTypes.FLOAT,
      defaultValue: 60,
      comment: '限速(km/h)'
    },
    lanes: {
      type: DataTypes.INTEGER,
      defaultValue: 2,
      comment: '车道数'
    }
  })
}
